# Domain: Payments (Acme Wallet example)

> Example domain rules for the fictional Acme Wallet. Replace with your own.

## Entities

- **Payment**: `id`, `brokerIdentifier` (unique), `status`, `amount`,
  `paidAmount`.
- **Allocation**: links one payment to one installment; the pair
  `(paymentId, installmentId)` is unique.

## Identity invariant

A payment MUST be associated to a person only after the person's identity has
been validated (CPF match). Email alone is NOT a sufficient identifier: emails
can be shared, outdated or duplicated across accounts, so associating a payment
to a person by payer email can attach money to the wrong customer. Any change
that replaces identity validation with an email lookup on the payment or
reconciliation path is a business-rule violation.

## Allocation invariants

- The open amount of a payment is `paidAmount − Σ(existing allocations)`, and it
  is distributed only across installments with `paidAt IS NULL`.
- Allocation is idempotent: an installment that already has an allocation for a
  payment is skipped.
- A payment already allocated must not be allocated again.

## Webhook invariants

- Only a broker status of `approved` triggers allocation.
- An out-of-order webhook must never move a payment back to an earlier status
  (for example `approved` → `pending`).

## Installment invariants

- An installment is marked as paid only when the paid amount covers the expected
  charge.
- Paid installments are immutable.
