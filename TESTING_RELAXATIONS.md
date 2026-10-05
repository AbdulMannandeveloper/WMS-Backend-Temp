# Testing-only deletes

While the company tests on live data, admins can delete records the app normally
keeps. All of it sits behind one switch and is meant to be removed once testing
is over.

## What it allows

| # | Delete | Normal rule |
|---|---|---|
| 1 | Approved invoices | Drafts only |
| 2 | Paid invoices, with their charges | Never |
| 3 | One employee's finalised pay for a month | The whole month, via Reopen |
| 4 | Products with dispatches or returns in their history | Deactivate only |
| 5 | Received freight shipments (admins) | Never |

Every delete that only the switch allowed is marked `testingMode: true` in the
audit log, as is turning the switch on and off (`TESTING_MODE_ON`,
`TESTING_MODE_OFF`), so they can be listed afterwards:

```sql
SELECT * FROM audit_logs
WHERE details::jsonb ->> 'testingMode' = 'true'
   OR action IN ('TESTING_MODE_ON', 'TESTING_MODE_OFF')
ORDER BY timestamp;
```

## The switch

- An admin turns it on in the app: profile menu → **Turn on testing mode…**,
  after confirming what it allows.
- It runs for **one week** from then and turns itself off. Pressing it again does
  not extend the week.
- While it is on, admins see a banner saying until when, with **Turn off**.
- After the week, admins see a banner saying it has ended, with **Turn on for
  another week** and **Dismiss**.
- The state is one row in the `settings` table (`TESTING_DELETES_STARTED_AT`,
  when it was turned on); no row means off. Every check reads it, so all workers
  agree. The server also logs it at startup while it is on.

## Removing it

Every testing-only piece is either a whole file starting with
`TESTING-ONLY (whole file)`, or lines enclosed by:

```js
// TESTING-ONLY start
...
// TESTING-ONLY end
```

(`{/* TESTING-ONLY start */}` … `{/* TESTING-ONLY end */}` in JSX). Deleting the
enclosed lines restores the normal rules; the code around them is written so
nothing else has to change. To find them all:

```sh
grep -rn "TESTING-ONLY" --exclude-dir=node_modules .
```

### Backend (this repo)

1. Delete the whole files:
   - `logic/testing_mode.logic.js`
   - `controllers/testing_mode.controller.js`
   - `routes/testing_mode.routes.js`
   - `test/helpers/testingMode.js`
   - `test/platform/testing-mode.test.js`
   - `test/payroll/pay-record-delete.test.js`
2. Delete the enclosed blocks in:
   - `app.js`, `server.js`
   - `logic/monthly_invoice.logic.js` (#1, #2)
   - `logic/payroll.logic.js`, `controllers/payroll.controller.js`,
     `routes/payroll.routes.js` (#3)
   - `logic/product.logic.js` (#4)
   - `logic/freight_shipment.logic.js`, `controllers/freight_shipment.controller.js` (#5)
   - `test/billing/invoice-lifecycle.test.js`, `test/billing/invoice-delete.test.js`,
     `test/products/delete-guard.test.js`, `test/freight/shipments.test.js`
3. Optional tidying the blocks leave behind, all harmless if left:
   - the `testing` option of `isDeletable` and the `chargesGoWith` option of
     `reportForLines` in `logic/monthly_invoice.logic.js`
   - the `isAdmin` option of the freight dependents and delete functions
   - `let` declarations that are no longer reassigned (`deleteOptions`,
     `shippedBlocking`, `relaxed`)
4. Remove the leftover row, if any:
   `DELETE FROM settings WHERE key = 'TESTING_DELETES_STARTED_AT';`
5. Run the tests.

### Frontend (the other repo)

See `TESTING_RELAXATIONS.md` there.
