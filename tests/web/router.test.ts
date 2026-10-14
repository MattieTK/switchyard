import { describe, expect, it } from "vitest";
import { parseHash } from "../../web/src/router.ts";

describe("parseHash", () => {
  it("defaults to the connect page", () => {
    expect(parseHash("")).toMatchObject({ page: "connect", id: undefined });
    expect(parseHash("#/")).toMatchObject({ page: "connect" });
  });

  it("reads page, id and query", () => {
    const r = parseHash("#/plan/prj_1?next=prj_2,prj_3");
    expect(r.page).toBe("plan");
    expect(r.id).toBe("prj_1");
    expect(r.query.get("next")).toBe("prj_2,prj_3");
  });

  it("reads a query on a page without an id", () => {
    expect(parseHash("#/connect?error=denied").query.get("error")).toBe("denied");
  });
});
