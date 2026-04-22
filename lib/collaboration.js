function normalizePermissionAlias(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "none") return "none";
  if (normalized === "read" || normalized === "pull" || normalized === "triage") return "read";
  if (normalized === "write" || normalized === "push" || normalized === "maintain") return "write";
  if (normalized === "admin") return "admin";
  return undefined;
}

function resolveOrgInvitationRole(value, fallback = "member") {
  if (value === undefined || value === null || value === "") return { role: fallback };
  if (typeof value !== "string") return { error: "role must be member or owner." };
  const normalized = value.trim().toLowerCase();
  if (normalized === "member" || normalized === "owner") return { role: normalized };
  return { error: `Unsupported role "${value}". Use member or owner.` };
}

function resolveTeamRole(value) {
  if (typeof value !== "string") return { error: "role must be member or maintainer." };
  const normalized = value.trim().toLowerCase();
  if (normalized === "member" || normalized === "maintainer") return { role: normalized };
  return { error: `Unsupported role "${value}". Use member or maintainer.` };
}

function repoSummaryFullName(repo) {
  if (!repo) return undefined;
  const fullName = typeof repo.full_name === "string" ? repo.full_name.trim() : "";
  if (fullName) return fullName;
  const owner = repo.owner && typeof repo.owner.login === "string" ? repo.owner.login.trim() : "";
  const name = typeof repo.name === "string" ? repo.name.trim() : "";
  if (owner && name) return `${owner}/${name}`;
  return name || undefined;
}

function filterDirectCollaborators(collaborators, ownerLogin) {
  const owner = String(ownerLogin || "").trim().toLowerCase();
  if (!owner) return collaborators;
  return collaborators.filter((c) => String((c && c.login) || "").trim().toLowerCase() !== owner);
}

async function listRepoAccessTeams(client, route, org, fullName) {
  const notes = [];
  const teams = await client.listOrgTeams(route, org);
  const withAccess = [];
  for (const team of teams) {
    const slug = (team && (team.slug || team.name) || "").trim();
    if (!slug) {
      notes.push(`Skipped a team in org "${org}" because it had no slug or name.`);
      continue;
    }
    try {
      const repos = await client.listTeamRepos(route, org, slug);
      const match = repos.find((r) => repoSummaryFullName(r) === fullName);
      if (!match) continue;
      withAccess.push({
        ...team,
        ...(match.permissions ? { permissions: match.permissions } : {}),
        ...(match.role_name ? { role_name: match.role_name } : {})
      });
    } catch (error) {
      notes.push(`Team repo lookup failed for ${org}/${slug}: ${String(error)}`);
    }
  }
  return { teams: withAccess, notes };
}

function renderCollaboratorLine(c) {
  const login = (c && c.login) || "(unknown)";
  const perms = c && c.permissions ? Object.entries(c.permissions).filter(([, v]) => v).map(([k]) => k).join(",") : "";
  const role = c && c.role_name ? c.role_name : perms;
  const tags = [];
  if (c && c.organization_member) tags.push("org-member");
  if (c && c.outside_collaborator) tags.push("outside");
  const tagText = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
  return role ? `${login} (${role})${tagText}` : `${login}${tagText}`;
}

function renderTeamLine(t) {
  const name = (t && (t.slug || t.name)) || "(unknown)";
  const perms = t && t.permissions ? Object.entries(t.permissions).filter(([, v]) => v).map(([k]) => k).join(",") : "";
  const role = t && (t.role_name || t.permission) ? (t.role_name || t.permission) : perms;
  return role ? `${name} (${role})` : name;
}

function renderRepoInvitationLine(inv) {
  const id = inv && inv.id;
  const invitee = inv && inv.invitee && (inv.invitee.login || inv.invitee.name) || "(unknown)";
  const perms = (inv && inv.permissions) || "";
  return `#${id} → ${invitee}${perms ? ` (${perms})` : ""}`;
}

function renderOrgInvitationLine(inv) {
  const id = inv && inv.id;
  const login = (inv && inv.login) || "(unknown)";
  const role = (inv && inv.role) || "member";
  const org = inv && inv.organization && inv.organization.login ? inv.organization.login : "";
  return `#${id} ${org ? `${org} → ` : ""}${login} (${role})`;
}

function renderOrgMembershipLine(m) {
  const state = (m && m.state) || "unknown";
  const role = (m && m.role) || "unknown";
  return `state=${state}, role=${role}`;
}

function renderOrgLine(org) {
  const login = (org && typeof org.login === "string" && org.login.trim()) || "unknown-org";
  const nameRaw = org && typeof org.name === "string" ? org.name.trim() : "";
  const name = nameRaw ? ` (${nameRaw})` : "";
  const permRaw = org && typeof org.default_repository_permission === "string" ? org.default_repository_permission.trim() : "";
  const permission = permRaw ? ` [default:${normalizePermissionAlias(permRaw) || permRaw}]` : "";
  const descRaw = org && typeof org.description === "string" ? org.description.trim() : "";
  const description = descRaw ? ` - ${descRaw}` : "";
  return `${login}${name}${permission}${description}`;
}

module.exports = {
  filterDirectCollaborators,
  listRepoAccessTeams,
  normalizePermissionAlias,
  renderCollaboratorLine,
  renderOrgInvitationLine,
  renderOrgLine,
  renderOrgMembershipLine,
  renderRepoInvitationLine,
  renderTeamLine,
  repoSummaryFullName,
  resolveOrgInvitationRole,
  resolveTeamRole
};
