---
name: api-documentation
description: "Use when documenting an API: OpenAPI/Swagger specs, endpoint reference, auth guides, examples and changelogs from the route code."
category: Software development
---

# API documentation

Docs are correct only if they match the code. Read the routes, schemas and error handler first.

## Inventory from code

```bash
grep -rnE "\.(get|post|put|patch|delete)\(['\"]/" src/          # Express/Fastify routes
grep -rnE "@(app|router)\.(get|post|put|patch|delete)\(" .       # FastAPI/Flask
```

For each route note: method, path, auth needed, path/query params, body schema, response schema,
status codes and error codes. Read validation schemas for exact types, limits and enums.

## OpenAPI 3.1 skeleton

```yaml
openapi: 3.1.0
info: { title: Acme Billing API, version: 1.4.0, description: Create and manage invoices. }
servers: [{ url: https://api.acme.example/v1 }]
security: [{ bearerAuth: [] }]
components:
  securitySchemes:
    bearerAuth: { type: http, scheme: bearer }
  schemas:
    Error:
      type: object
      required: [error]
      properties: { error: { type: string }, code: { type: string } }
    Invoice:
      type: object
      required: [id, number, status, total]
      properties:
        id: { type: string, example: inv_8f2k }
        number: { type: string, example: INV-2026-0042 }
        status: { type: string, enum: [draft, sent, paid] }
        total: { type: string, description: Decimal amount, example: "1416.00" }
paths:
  /invoices/{id}:
    get:
      summary: Get an invoice
      operationId: getInvoice
      parameters: [{ name: id, in: path, required: true, schema: { type: string } }]
      responses:
        "200": { description: The invoice, content: { application/json: { schema: { $ref: "#/components/schemas/Invoice" } } } }
        "404": { description: Not found, content: { application/json: { schema: { $ref: "#/components/schemas/Error" } } } }
```

Rules: reuse schemas through `$ref`; give every operation an `operationId` and a one-line summary;
document every status code the code can return; include realistic examples (not "string").

Validate the YAML parses: `python3 -c "import yaml,sys; yaml.safe_load(open('openapi.yaml'))"` (or
`json.load` for JSON). If `npx @redocly/cli lint` is available, run it.

## Human-readable reference (Markdown)

For each endpoint:

````markdown
### Create an invoice
`POST /invoices` · requires `invoices:write`

| Field | Type | Required | Notes |
|---|---|---|---|
| customerId | string | yes | |
| lines | array | yes | 1–100 items |

```bash
curl -X POST https://api.acme.example/v1/invoices \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"customerId":"cus_12","lines":[{"description":"Consulting","qty":10,"unitPrice":"120.00"}]}'
```

**201** returns the invoice. **400** invalid fields · **404** unknown customer.
````

## Also document

- **Getting started**: base URL, how to get credentials, the first request that works.
- **Authentication** and scopes; token lifetime and refresh.
- **Errors**: the shared error shape and a table of `code` values.
- **Pagination, rate limits, idempotency, versioning and deprecation policy.**
- **Changelog**: dated entries, breaking changes marked clearly.

## Done when

Every route in code is documented (and nothing documented that doesn't exist), the spec parses,
examples are copy-pasteable, and you list anything you couldn't confirm from the code.
