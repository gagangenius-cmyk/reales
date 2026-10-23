import { afterAll, describe, expect, it } from "vitest";
import { QueryTypes } from "sequelize";
import { createIngestSource, createLead, nextBestActions, publicLeadFormInfo, setIngestSourceActive, submitPublicLeadForm } from "@reales/domain";
import { ConflictError, NotFoundError } from "@reales/domain";
import { closeTestDb, makeTenant, testDb, uniq } from "./helpers";
import { agentIn, makeOrg } from "./brokerage-helpers";
import { phone } from "./deal-helpers";

const sq = () => testDb();
afterAll(closeTestDb);

describe("hosted lead form", () => {
  it("only website sources are public; a submission becomes one lead, repeats the same day are merged, bots and bad input create nothing", async () => {
    const t = await makeTenant();
    const web: any = await createIngestSource(sq(), t.admin, { name: "Landing page", kind: "website", defaultPurpose: "buy" } as never);
    const portal: any = await createIngestSource(sq(), t.admin, { name: "Portal", kind: "portal", defaultPurpose: "buy" } as never);
    expect(await publicLeadFormInfo(sq(), web.publicId)).toMatchObject({ source: "Landing page", purpose: "buy" });
    expect(await publicLeadFormInfo(sq(), portal.publicId)).toBeNull();
    expect(await publicLeadFormInfo(sq(), "nope")).toBeNull();
    await expect(submitPublicLeadForm(sq(), portal.publicId, { name: "X", phone: "0501112222" })).rejects.toBeInstanceOf(NotFoundError);
    const count = async () => Number(((await sq().query<{ n: number }>("SELECT COUNT(*) AS n FROM leads WHERE tenant_id=:t", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT }))[0]!.n));
    const p = phone();
    await submitPublicLeadForm(sq(), web.publicId, { name: "Sara Khan", phone: p, message: "Interested in a 2BR", purpose: "rent" });
    expect(await count()).toBe(1);
    await submitPublicLeadForm(sq(), web.publicId, { name: "Sara Khan", phone: p });
    expect(await count()).toBe(1); // same person, same day
    await submitPublicLeadForm(sq(), web.publicId, { name: "Bot", phone: phone(), website: "http://spam" });
    expect(await count()).toBe(1); // honeypot
    await expect(submitPublicLeadForm(sq(), web.publicId, { name: "", phone: p })).rejects.toBeInstanceOf(ConflictError);
    await expect(submitPublicLeadForm(sq(), web.publicId, { name: "A" })).rejects.toThrow(/phone number or an email/);
    await expect(submitPublicLeadForm(sq(), web.publicId, { name: "A", email: "not-an-email" })).rejects.toThrow(/email/);
    await expect(submitPublicLeadForm(sq(), web.publicId, { name: "A", phone: "12" })).rejects.toThrow(/phone/);
    const [lead] = await sq().query<{ purpose: string; notes: string | null }>("SELECT l.purpose, (SELECT summary FROM activities WHERE entity_id=l.id LIMIT 1) AS notes FROM leads l WHERE l.tenant_id=:t", { replacements: { t: t.tenantId }, type: QueryTypes.SELECT });
    expect(lead!.purpose).toBe("rent");
    await setIngestSourceActive(sq(), t.admin, web.id, false);
    expect(await publicLeadFormInfo(sq(), web.publicId)).toBeNull();
    await expect(submitPublicLeadForm(sq(), web.publicId, { name: "Late", phone: phone() })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("next best actions", () => {
  it("lists what to do about a lead, urgent first, from facts about it, and nothing for a closed lead", async () => {
    const t = await makeTenant();
    const org = await makeOrg(t);
    const agent = await agentIn(t, org.marina.id, org.bu.id);
    const l: any = await createLead(sq(), t.admin, { contact: { firstName: uniq("N"), phone: phone() }, purpose: "buy", sourceCode: "walk_in", assignedUserId: agent.id } as never);
    const id = l.lead.id as string;
    let keys = (await nextBestActions(sq(), t.admin, id, new Date(Date.now() + 30 * 60_000))).map((a) => a.key);
    expect(keys).toContain("first_contact");
    expect(keys).toContain("set_follow_up");
    expect((await nextBestActions(sq(), t.admin, id, new Date(Date.now() + 30 * 60_000)))[0]!.severity).toBe("urgent");
    await sq().query("UPDATE leads SET last_contacted_at=DATE_SUB(NOW(3), INTERVAL 3 DAY), first_response_at=DATE_SUB(NOW(3), INTERVAL 3 DAY), is_hot=1, next_follow_up_at=DATE_SUB(NOW(3), INTERVAL 1 HOUR) WHERE id=:id", { replacements: { id }, type: QueryTypes.UPDATE });
    keys = (await nextBestActions(sq(), t.admin, id)).map((a) => a.key);
    expect(keys).toEqual(expect.arrayContaining(["follow_up_overdue", "hot_quiet"]));
    expect(keys).not.toContain("first_contact");
    const un: any = await createLead(sq(), t.admin, { contact: { firstName: uniq("U"), phone: phone() }, purpose: "rent", sourceCode: "walk_in" } as never);
    await sq().query("UPDATE leads SET assigned_user_id=NULL, pool_id=NULL WHERE id=:id", { replacements: { id: un.lead.id }, type: QueryTypes.UPDATE });
    expect((await nextBestActions(sq(), t.admin, un.lead.id)).map((a) => a.key)).toContain("assign");
    await sq().query("UPDATE leads SET status='won' WHERE id=:id", { replacements: { id }, type: QueryTypes.UPDATE });
    expect(await nextBestActions(sq(), t.admin, id)).toEqual([]);
  });
});
