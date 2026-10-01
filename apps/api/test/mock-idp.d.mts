export function startMockIdp(opts?: { port?: number; clientId?: string; clientSecret?: string; emailVerified?: boolean }): Promise<{
  issuer: string;
  clientId: string;
  clientSecret: string;
  state: { emailVerified: boolean; logins: number };
  close: () => Promise<void>;
}>;
