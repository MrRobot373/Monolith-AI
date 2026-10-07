---
name: react-typescript
description: "Use when writing React components with TypeScript (Vite, Next.js): props and types, hooks, data fetching, forms, performance, tests."
category: Software development
---

# React with TypeScript

## Before you write code

- Check versions in `package.json` (React 18 vs 19, Next.js app vs pages router, router library).
  Follow that version's APIs; don't mix patterns.
- Find one well-written existing component and match its style: file naming, export style, styling,
  how it fetches data, how tests look.

## Components

```tsx
interface InvoiceRowProps {
  invoice: Invoice;
  onOpen: (id: string) => void;
  selected?: boolean;
}

export function InvoiceRow({ invoice, onOpen, selected = false }: InvoiceRowProps) {
  return (
    <button type="button" className={cn("row", selected && "row--selected")} onClick={() => onOpen(invoice.id)}>
      <span>{invoice.number}</span>
      <span>{formatMoney(invoice.total, invoice.currency)}</span>
    </button>
  );
}
```

- Props interface named `<Component>Props`; optional props get defaults in destructuring.
- No `any`. Use `unknown` + narrowing for untrusted data; validate API responses at the boundary
  (zod or a hand-written guard).
- Model variants as unions: `type Status = "draft" | "sent" | "paid";` and exhaust them in switches.
- Keep components pure: no data fetching or side effects in render.
- Lists need stable `key`s (ids, never array indexes for reorderable lists).

## Hooks

- `useState` for local UI state; derive everything else during render (don't sync state to state).
- `useEffect` only to sync with something outside React (subscriptions, timers, DOM APIs). Return a
  cleanup. If you're fetching data in an effect, prefer the project's data library instead.
- `useMemo`/`useCallback` only for measured costs or stable identities that a child or effect needs.
- Custom hooks (`useInvoices`) own data loading and return `{ data, error, isLoading }`.
- Follow the rules of hooks: top level only, same order every render.

## Data fetching

- Use what the project uses (TanStack Query, SWR, Next.js server components, loaders).
- Every query has loading, error and empty UI. Mutations invalidate or update the cache, disable
  their button while pending, and show errors inline.
- Abort or ignore stale responses when inputs change quickly (search boxes).

## Forms

- Controlled inputs for small forms; react-hook-form (if present) for large ones.
- Labels for every field, inline error messages, keep values on error, disable submit while saving.
- Validate with the same schema the server uses when possible.

## Performance

- Find the slow part before optimizing (React Profiler, `console.time`).
- Long lists (>200 rows): paginate or virtualize. Heavy routes: `lazy()` + `Suspense`.
- Avoid creating new objects/functions in props of memoized children only when it matters.

## Next.js specifics (when present)

- App router: server components by default; add `"use client"` only to components that need state,
  effects or browser APIs. Keep secrets and database access on the server.
- Use `next/link`, `next/image`; metadata via `export const metadata` / `generateMetadata`.

## Tests

- Testing Library: test behavior through roles and labels (`getByRole("button", { name: /save/i })`),
  not implementation details.
- Cover: renders with data, empty and error states, the main interaction, a validation error.
- Run `npx tsc --noEmit`, the linter, and tests before finishing.

## Done when

Types check with no `any` added, every async view has its states, tests for the new behavior pass,
and you've listed changed components and how to see them.
