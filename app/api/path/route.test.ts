import { expect, test } from "bun:test";
import { pathRelTypes } from "./route";

test("path traverses blood only by default", () => {
  expect(pathRelTypes(false)).toBe("PARENT_OF");
});

test("opting into spouses adds marriage edges", () => {
  expect(pathRelTypes(true)).toBe("PARENT_OF|SPOUSE_OF");
});

// A sibling hop can't be verified in the ego view (which traverses PARENT_OF only),
// and an adoptive hop bridges unrelated houses via 家督 succession — neither belongs
// in a lineage path, in either toggle state.
test("neither state traverses siblings or adoption", () => {
  for (const types of [pathRelTypes(false), pathRelTypes(true)]) {
    expect(types).not.toContain("SIBLING_OF");
    expect(types).not.toContain("ADOPTIVE_PARENT_OF");
  }
});
