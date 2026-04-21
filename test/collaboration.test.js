const test = require("node:test");
const assert = require("node:assert/strict");
const collab = require("../lib/collaboration");

test("normalizePermissionAlias maps common synonyms", () => {
  assert.equal(collab.normalizePermissionAlias("pull"), "read");
  assert.equal(collab.normalizePermissionAlias("push"), "write");
  assert.equal(collab.normalizePermissionAlias("MAINTAIN"), "write");
  assert.equal(collab.normalizePermissionAlias("admin"), "admin");
  assert.equal(collab.normalizePermissionAlias("none"), "none");
  assert.equal(collab.normalizePermissionAlias("bogus"), undefined);
  assert.equal(collab.normalizePermissionAlias(42), undefined);
});

test("resolveOrgInvitationRole accepts member/owner and falls back", () => {
  assert.deepEqual(collab.resolveOrgInvitationRole(undefined, "member"), { role: "member" });
  assert.deepEqual(collab.resolveOrgInvitationRole("", "owner"), { role: "owner" });
  assert.deepEqual(collab.resolveOrgInvitationRole("OWNER"), { role: "owner" });
  assert.ok("error" in collab.resolveOrgInvitationRole("admin"));
  assert.ok("error" in collab.resolveOrgInvitationRole(7));
});

test("resolveTeamRole rejects unknown roles", () => {
  assert.deepEqual(collab.resolveTeamRole("maintainer"), { role: "maintainer" });
  assert.deepEqual(collab.resolveTeamRole("member"), { role: "member" });
  assert.ok("error" in collab.resolveTeamRole("admin"));
  assert.ok("error" in collab.resolveTeamRole(""));
});

test("filterDirectCollaborators removes the owner case-insensitively", () => {
  const all = [{ login: "Alice" }, { login: "bob" }, { login: "ALICE" }];
  const filtered = collab.filterDirectCollaborators(all, "alice");
  assert.deepEqual(filtered.map((c) => c.login), ["bob"]);
});

test("repoSummaryFullName prefers full_name, falls back to owner/name", () => {
  assert.equal(collab.repoSummaryFullName({ full_name: "o/r" }), "o/r");
  assert.equal(collab.repoSummaryFullName({ owner: { login: "o" }, name: "r" }), "o/r");
  assert.equal(collab.repoSummaryFullName({ name: "r" }), "r");
  assert.equal(collab.repoSummaryFullName(undefined), undefined);
});

test("listRepoAccessTeams collects teams that see the repo", async () => {
  const client = {
    async listOrgTeams() {
      return [{ slug: "core", name: "Core" }, { slug: "ops", name: "Ops" }, { slug: "", name: "" }];
    },
    async listTeamRepos(_route, _org, slug) {
      if (slug === "core") return [{ full_name: "acme/memory", permissions: { push: true } }];
      if (slug === "ops") return [{ full_name: "acme/other" }];
      return [];
    }
  };
  const result = await collab.listRepoAccessTeams(client, null, "acme", "acme/memory");
  assert.equal(result.teams.length, 1);
  assert.equal(result.teams[0].slug, "core");
  assert.deepEqual(result.teams[0].permissions, { push: true });
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /no slug or name/);
});
