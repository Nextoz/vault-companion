// Vite/Vitest `?raw` imports (tests only): the file's text. Avoids Node types in the Worker project.
declare module '*?raw' {
  const text: string;
  export default text;
}
