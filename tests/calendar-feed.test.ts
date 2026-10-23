import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import { calendarFeedByToken, createTask, myCalendarFeed } from "@reales/domain";
import { closeTestDb, makeTenant, makeUser, testDb, uniq } from "./helpers";

const sq = () => testDb();
afterAll(closeTestDb);

describe("calendar subscription feed", () => {
  it("serves the owner's own agenda to anyone holding the secret link, and stops when the link is rotated or the user is disabled", async () => {
    const t = await makeTenant();
    const mine = await makeUser(t, ["agent"]), theirs = await makeUser(t, ["agent"]);
    const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const title = uniq("Call buyer");
    await createTask(sq(), mine.ctx, { title, assigneeId: mine.id, dueAt: due });
    await createTask(sq(), theirs.ctx, { title: "Someone else's task", assigneeId: theirs.id, dueAt: due });
    const { token } = await myCalendarFeed(sq(), mine.ctx);
    expect((await myCalendarFeed(sq(), mine.ctx)).token).toBe(token); // stable until rotated
    const ics = (await calendarFeedByToken(sq(), token))!;
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain(title);
    expect(ics).not.toContain("Someone else");
    expect(await calendarFeedByToken(sq(), "x".repeat(40))).toBeNull();
    expect(await calendarFeedByToken(sq(), "short")).toBeNull();
    const { token: fresh } = await myCalendarFeed(sq(), mine.ctx, true);
    expect(fresh).not.toBe(token);
    expect(await calendarFeedByToken(sq(), token)).toBeNull();
    expect(await calendarFeedByToken(sq(), fresh)).toContain(title);
    await sq().query("UPDATE users SET status='disabled' WHERE id=:id", { replacements: { id: mine.id }, type: QueryTypes.UPDATE });
    expect(await calendarFeedByToken(sq(), fresh)).toBeNull();
  });
});
