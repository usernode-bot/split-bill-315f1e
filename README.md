# Split Bill

Split bills with friends: record who paid, how a bill splits, and who has
settled up.

- **Bill list** — every bill with its title, total, who paid and the date,
  plus a "x of y paid" progress badge that flips to "Settled".
- **Bill detail** — the equal split per person: the payer's row, what each
  friend owes, and a mark-paid toggle per friend with a running
  "still owed to …" total.
- **Add bill** — a validated form (title of at least 3 characters, an
  amount, comma-separated friends, and who paid) that splits the total
  evenly, spare cents included.

## How it's built

- Node.js / Express server (`server.js`) with the app's own Postgres
  database. Bills live in `bills` and `bill_shares`, both marked
  `staging:private` (bills are per-user financial data). Amounts are stored
  as integer cents, never floats.
- Every bill belongs to the signed-in Homeroom user; the platform-issued
  RS256 token authenticates each request.
- Tailwind CSS, precompiled by `npm run build` during image creation with
  either Kubernetes/Paketo or standalone Docker. Light and dark themes both
  supported — the platform forwards the viewer's choice through the bridge.
- Staging previews support `?demo=1` on any route, which appends a couple
  of "Staging demo" example bills served in-memory (never written to the
  database) so testers can exercise list, detail and mark-paid flows.