declare module '@github/copilot-sdk/extension' {
  export interface ExtensionSession {
    readonly sessionId?: unknown;
    on(event: string, handler: (event: { readonly data?: unknown }) => void): unknown;
  }
  export function joinSession(options: { tools: readonly unknown[] }): Promise<ExtensionSession>;
}
