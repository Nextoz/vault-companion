// Phone-like client: plain HTTP with the real wire contracts. Every envelope is validated with `Command` before it is
// sent and every answer is parsed with `Receipt` / `ApiError` / `TasksResponse`, so a contract drift fails here.
import { ActiveWorkResponse, ApiError, Command, encodeNoteHeader, NOTE_HEADER, NoteReadResponse, NotesResponse, Receipt, SessionResponse, TasksResponse, type CommandType } from '@vault-companion/contracts';
import { randomUUID } from 'node:crypto';
import { APP_ORIGIN } from './server.ts';

export type CommandAnswer =
  | { readonly status: 200; readonly receipt: Receipt }
  | { readonly status: number; readonly error: ApiError };

export type TasksAnswer = { readonly status: 200; readonly tasks: TasksResponse } | { readonly status: number; readonly error: ApiError };

export class Phone {
  private constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    readonly accountKey: string,
    private readonly occurredAt: string,
  ) {}

  static async signIn(baseUrl: string, token: string, occurredAt: string): Promise<Phone> {
    const res = await fetch(`${baseUrl}/api/session`, { headers: { 'Cf-Access-Jwt-Assertion': token } });
    if (res.status !== 200) throw new Error(`session failed: ${res.status}`);
    return new Phone(baseUrl, token, SessionResponse.parse(await res.json()).accountKey, occurredAt);
  }

  async tasks(known: readonly string[] = []): Promise<TasksAnswer> {
    const q = known.length ? `?known=${known.join(',')}` : '';
    const res = await fetch(`${this.baseUrl}/api/tasks${q}`, { headers: { 'Cf-Access-Jwt-Assertion': this.token } });
    const body: unknown = await res.json();
    return res.status === 200 ? { status: 200, tasks: TasksResponse.parse(body) } : { status: res.status, error: ApiError.parse(body) };
  }

  /** Read the task list; throws unless the read succeeded. */
  async read(): Promise<TasksResponse> {
    const r = await this.tasks();
    if (!('tasks' in r)) throw new Error(`read failed: ${r.status} ${r.error.code}`);
    return r.tasks;
  }

  async activeWork(): Promise<Extract<ActiveWorkResponse, { status: 'ok' }>> {
    const res = await fetch(`${this.baseUrl}/api/active-work`, { headers: { 'Cf-Access-Jwt-Assertion': this.token } });
    const r = ActiveWorkResponse.parse(await res.json());
    if (r.status !== 'ok') throw new Error(`Active Work read failed: ${r.status}`);
    return r;
  }

  /** ADR-0022: the Inbox notes list. */
  async notes(): Promise<NotesResponse> {
    const res = await fetch(`${this.baseUrl}/api/notes`, { headers: { 'Cf-Access-Jwt-Assertion': this.token } });
    if (res.status !== 200) throw new Error(`notes failed: ${res.status}`);
    return NotesResponse.parse(await res.json());
  }

  /** ADR-0022: one Inbox note; throws unless it was read. */
  async note(path: string): Promise<Extract<NoteReadResponse, { status: 'ok' }>> {
    const res = await fetch(`${this.baseUrl}/api/notes/read`, { headers: { 'Cf-Access-Jwt-Assertion': this.token, [NOTE_HEADER]: encodeNoteHeader(path) } });
    const r = NoteReadResponse.parse(await res.json());
    if (r.status !== 'ok') throw new Error(`note read failed: ${r.code}`);
    return r;
  }

  envelope<T extends CommandType>(type: T, payload: Extract<Command, { type: T }>['payload'], baseRevision: string): Extract<Command, { type: T }> {
    return Command.parse({ schemaVersion: 1, operationId: randomUUID(), type, occurredAt: this.occurredAt, baseRevision, payload }) as Extract<Command, { type: T }>;
  }

  /** One POST. Rejects when the connection is lost before an answer arrives (the phone's "unknown outcome"). */
  async send(command: Command): Promise<CommandAnswer> {
    const res = await fetch(`${this.baseUrl}/api/commands`, {
      method: 'POST',
      headers: {
        'Cf-Access-Jwt-Assertion': this.token,
        Origin: APP_ORIGIN,
        'X-VC-Request': '1',
        'X-VC-Account': this.accountKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
    });
    const body: unknown = await res.json();
    return res.status === 200 ? { status: 200, receipt: Receipt.parse(body) } : { status: res.status, error: ApiError.parse(body) };
  }

  /** What the phone queue does: resend the identical envelope while the server says the failure is retryable. */
  async sendUntilSettled(command: Command, maxTries = 5): Promise<CommandAnswer> {
    let answer = await this.send(command);
    for (let i = 1; i < maxTries && 'error' in answer && answer.error.retryable; i++) answer = await this.send(command);
    return answer;
  }
}
