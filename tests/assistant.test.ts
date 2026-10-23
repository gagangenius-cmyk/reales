import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { askAssistant, interpretWithModel, createEmployee, createLead, createListingFromProperty, setModules } from "@reales/domain";
import { closeTestDb, makeTenant, makeUser, testDb, uniq } from "./helpers";
import { agentIn, makeOrg } from "./brokerage-helpers";
import { phone } from "./deal-helpers";

const sq = () => testDb();
afterAll(closeTestDb);

describe("assistant", () => {
  it("answers lead, listing, team and search questions from visible data, with links, and refuses what the person cannot see", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const agent = await agentIn(t, org.marina.id, org.bu.id);
    const hr = await makeUser(t, ["agent"]);
    const first = uniq("Hotlead");
    await createLead(sq(), t.admin, { contact: { firstName: first, phone: phone() }, purpose: "buy", sourceCode: "walk_in", assignedUserId: agent.id, isHot: true } as never);
    await createLead(sq(), t.admin, { contact: { firstName: uniq("Cold"), phone: phone() }, purpose: "rent", sourceCode: "walk_in" } as never);
    await createListingFromProperty(sq(), t.admin, { emirate: "Dubai", community: "Dubai Marina", buildingName: "Assistant Tower", unitNumber: "7", type: "apartment", purpose: "sale", price: 1_000_000, bedrooms: 1, builtUpAreaSqft: 800 });
    await createEmployee(sq(), t.admin, { fullName: "On Leave Olga", joinedOn: "2024-01-01", userId: hr.id });

    const hot = await askAssistant(sq(), t.admin, "Show me the HOT leads");
    expect(hot.answer).toMatch(/1 hot open leads/);
    expect(hot.items[0]!.href).toMatch(/^\/leads\//);
    expect((await askAssistant(sq(), t.admin, "unassigned leads")).answer).toMatch(/1 unassigned open leads/);
    expect((await askAssistant(sq(), t.admin, "new leads today")).answer).toMatch(/2 new leads today/);
    expect((await askAssistant(sq(), t.admin, "leads")).answer).toMatch(/2 open leads/);
    // an agent only sees their own leads
    expect((await askAssistant(sq(), agent.ctx, "hot leads")).answer).toMatch(/1 hot open leads/);
    expect((await askAssistant(sq(), agent.ctx, "unassigned leads")).answer).toMatch(/No unassigned open leads|0|No /);
    const noPhotos = await askAssistant(sq(), t.admin, "listings without photos");
    expect(noPhotos.answer).toMatch(/1 listings with no photos/);
    expect(noPhotos.link?.href).toBe("/listings?noPhotos=1");
    const found = await askAssistant(sq(), t.admin, `find ${first}`);
    expect(found.items.length).toBeGreaterThan(0);
    // HR questions need hr.read
    expect((await askAssistant(sq(), t.admin, "who is late today")).answer).toMatch(/Nobody late today|late today/);
    expect((await askAssistant(sq(), agent.ctx, "who is on leave today")).answer).toMatch(/do not have access/);
    expect((await askAssistant(sq(), t.admin, "what is the meaning of life and the universe")).answer).toMatch(/did not understand/);
    expect((await askAssistant(sq(), t.admin, "")).suggestions.length).toBeGreaterThan(3);
    // a module the company switched off is reported, not queried
    await setModules(sq(), t.admin, { listings: false, syndication: false, website: false, matching: false, valuation: false, deals: false, commissions: false });
    expect((await askAssistant(sq(), t.admin, "listings expiring this week")).answer).toMatch(/switched off/);
  });
});

describe("assistant language-model front end", () => {
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; });
  const reply = (text: string, status = 200) => vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status }));

  it("does nothing without an API key and only accepts a known command or a find request from the model", async () => {
    expect(await interpretWithModel("anything")).toBeNull();
    process.env.ANTHROPIC_API_KEY = "test-key";
    expect(await interpretWithModel("who has not been called", reply("Leads never contacted") as never)).toBe("leads never contacted");
    expect(await interpretWithModel("x", reply("find Sara Khan") as never)).toBe("find Sara Khan");
    expect(await interpretWithModel("x", reply("DROP TABLE leads") as never)).toBeNull();
    expect(await interpretWithModel("x", reply("UNKNOWN") as never)).toBeNull();
    expect(await interpretWithModel("x", reply("hot leads", 500) as never)).toBeNull();
    expect(await interpretWithModel("x", (async () => { throw new Error("offline"); }) as never)).toBeNull();
  });

  it("sends only the question text to the model, and runs the command it picks under the asker's permissions", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const agent = await agentIn(t, org.marina.id, org.bu.id);
    await createLead(sq(), t.admin, { contact: { firstName: uniq("Cold"), phone: phone() }, purpose: "buy", sourceCode: "walk_in", assignedUserId: agent.id } as never);
    process.env.ANTHROPIC_API_KEY = "test-key";
    const f = reply("leads never contacted");
    vi.stubGlobal("fetch", f);
    const a = await askAssistant(sq(), agent.ctx, "which enquiries has nobody picked up yet");
    expect(a.answer).toMatch(/1 open leads nobody has contacted yet/);
    const sent = JSON.parse((f.mock.calls[0] as any)[1].body);
    expect(JSON.stringify(sent)).not.toContain(agent.email);
    expect(sent.messages[0].content).toBe("which enquiries has nobody picked up yet");
    expect(f).toHaveBeenCalledTimes(1);
    // a question the rules understand never leaves the server
    await askAssistant(sq(), agent.ctx, "hot leads");
    expect(f).toHaveBeenCalledTimes(1);
  });
});
