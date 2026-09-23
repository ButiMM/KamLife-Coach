-- WHY A SUBSCRIPTION ENDED (2026-09-22).
--
-- `subscription_status = 'inactive'` plus `cancelled_at` was written by four different events —
-- the client cancelling, a renewal lapsing, PayFast cancelling, and a refund — and read back as
-- if it meant one of them. runPaymentFailureRecovery read it as "the payment failed", so a client
-- who had just cancelled was told "your payment didn't go through … update your payment here".
-- And the next PayFast charge on a cancelled subscription could not tell that the client had
-- chosen to leave, so it reactivated them and nulled `cancelled_at`.
--
-- The status stays 'inactive' for every one of these: the subscription gate blocks exactly
-- 'inactive', and a new status value would UNGATE every client carrying it. The reason is
-- recorded beside it instead:
--
--     client_cancelled   the client confirmed a cancel in the chat
--     payment_lapsed     the renewal went unpaid past the grace period
--     payfast_cancelled  PayFast told us the subscription was cancelled on its side
--     refunded           the payment was refunded
--
-- Additive and idempotent: nullable, IF NOT EXISTS, nothing dropped. Rows that ended before this
-- lands carry NULL, which every reader treats as "reason unknown" — never as a lapse.

ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_end_reason TEXT;

-- BACKFILL THE CLIENTS WHO CANCELLED BEFORE THIS COLUMN EXISTED (Codex attack on #277 @ 14f70ad).
-- Leaving them NULL made them invisible to the charge-after-cancellation guard: their next PayFast
-- charge reactivated them and nulled cancelled_at, exactly the defect this migration exists for.
-- A voluntary cancel is identifiable: the cancel-confirmation turn is in chat_history within
-- minutes of cancelled_at. A lapse has no such turn and stays NULL (never "payment_lapsed" here:
-- that would re-arm failure messages at people nobody can prove lapsed). Idempotent — only NULLs.
UPDATE users u SET subscription_end_reason = 'client_cancelled'
 WHERE u.subscription_end_reason IS NULL
   AND u.subscription_status = 'inactive'
   AND u.cancelled_at IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM chat_history c
      WHERE c.user_id = u.id AND c.intent = 'CANCEL_CONFIRMED'
        AND c.created_at BETWEEN u.cancelled_at - interval '10 minutes' AND u.cancelled_at + interval '10 minutes'
   );
