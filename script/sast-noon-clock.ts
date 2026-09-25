/**
 * TESTS RUN AT MIDDAY, WHATEVER THE HOUR (#404). Several harnesses log "lunch today" and read the wall
 * clock. Just after midnight SAST the product rightly reads "lunch" as yesterday's, so CI went red for
 * every PR between 00:00 and about 02:00 SAST. Imported FIRST by those harnesses: it moves this
 * process's clock forward to 12:00 SAST on the SAME South African day, so the JS clock and the
 * database's now() still agree on the day, and the clock keeps ticking. The product is untouched.
 */
const SAST_MS = 2 * 60 * 60 * 1000;
const RealDate = Date;
const real = RealDate.now();
const sastDayStartUtc = Math.floor((real + SAST_MS) / 86_400_000) * 86_400_000 - SAST_MS;
const noon = sastDayStartUtc + 12 * 60 * 60 * 1000;
const offset = Math.max(0, noon - real); // only ever forward, and only before midday
if (offset > 0 && process.env.SAST_NOON_CLOCK !== "off") {
  class ShiftedDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [any]));
    }
    static now() { return RealDate.now() + offset; }
  }
  (globalThis as any).Date = ShiftedDate;
  console.log(`[SAST_NOON_CLOCK] test clock moved forward ${Math.round(offset / 60000)} min to 12:00 SAST (#404)`);
}
export {};
