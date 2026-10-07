export interface SinkMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  links: string[];
}
export function startSmtpSink(): Promise<{
  port: number;
  messages: SinkMessage[];
  next(to: string, subject?: string, timeoutMs?: number): Promise<SinkMessage>;
  close(): Promise<void>;
}>;
