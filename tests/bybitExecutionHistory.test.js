"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchAllExecutionPages } = require("../lib/bybit");

test("Bybit execution history fetch follows every cursor and combines pages", async () => {
  const cursors = [];
  const rows = await fetchAllExecutionPages(async (cursor) => {
    cursors.push(cursor || null);
    if (!cursor) return { list: [{ execId: "fill-1" }], nextPageCursor: "page-2" };
    return { list: [{ execId: "fill-2" }], nextPageCursor: "" };
  });

  assert.deepEqual(cursors, [null, "page-2"]);
  assert.deepEqual(rows.map((row) => row.execId), ["fill-1", "fill-2"]);
});

test("Bybit execution history pagination fails closed on repeated cursors", async () => {
  await assert.rejects(fetchAllExecutionPages(async () => ({ list: [], nextPageCursor: "same" })), /repeated cursor/);
});

test("Bybit execution history pagination fails closed when safety page limit is exceeded", async () => {
  let page = 0;
  await assert.rejects(
    fetchAllExecutionPages(async () => ({ list: [], nextPageCursor: `next-${++page}` }), 2),
    /safety page limit/
  );
});
