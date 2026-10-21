# Business Context — Acme Wallet (example domain)

> **Example knowledge base.** Acme Wallet is a fictional digital wallet used to
> demonstrate how Revisor consumes business context. Replace these files with
> your own product's rules. The reviewer treats this directory as ground truth.

## Product

Acme Wallet lets customers receive payments (PIX, boleto, credit card) through
an external payment broker and pay monthly installments of financed purchases.
A broker notifies the wallet through webhooks; the wallet allocates each
approved payment to the customer's open installments.

## Core entities

- **Person** — the customer. Identified by a validated fiscal document (CPF).
- **Payment** — money received from the broker; carries a unique broker
  identifier and a lifecycle `status`.
- **Installment** — a monthly charge owed by a person; `paidAt = null` means open.
- **Allocation** — the ledger line linking a payment to an installment.

## Non-negotiable business principles

1. **Identity before money.** A payment is associated to a person only after
   identity validation. See [`payments.md`](./domain/payments.md#identity-invariant).
2. **Allocation is idempotent.** The same payment must never be allocated twice
   to the same installment.
3. **Paid installments are immutable.**
4. **Money is never a float.** Amounts use a decimal type or integer cents,
   consistently per module. See [`architecture.md`](./architecture.md#money).

## Where the details live

- Payments, identity, allocation: [`domain/payments.md`](./domain/payments.md)
