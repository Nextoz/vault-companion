// Runtime module provided by the Workers platform (Email Routing `send_email` binding); no workers-types installed.
declare module 'cloudflare:email' {
  export class EmailMessage {
    constructor(from: string, to: string, raw: string);
  }
}
