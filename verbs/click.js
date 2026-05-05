export default {
  name: "click",
  primaryKey: "selector",
  async execute(page, args) {
    const timeout = args.timeout ?? 10_000;
    try {
      await page.click(args.selector, { timeout });
      return `${args.selector}`;
    } catch (err) {
      // Text-fallback: when the selector times out (typically a brittle
      // class/id rename), retry against visible text. We DELIBERATELY
      // re-throw the ORIGINAL error if the fallback also fails — the
      // selector failure is the actionable signal for error classification
      // upstream; the fallback's failure would obscure it.
      const isTimeout = err && err.name === "TimeoutError";
      if (isTimeout && args.text_fallback) {
        try {
          await page
            .getByText(args.text_fallback, { exact: false })
            .first()
            .click({ timeout });
          return `${args.selector} (via text="${args.text_fallback}")`;
        } catch {
          throw err;
        }
      }
      throw err;
    }
  },
};
