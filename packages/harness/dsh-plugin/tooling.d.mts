export const REMINDER_OPEN: string;
export const REMINDER_CLOSE: string;
export const REMIND_AFTER: number;
export const REMIND_EVERY: number;
export function cleanArgs(name: string, args: unknown, mode: string): unknown;
export function planReminder(todos: { content: string; status: string }[] | null, since: number): string | null;
export function stripReminders(text: string): string;
