// La entrada de pruebas de `@clanker/core` (`@clanker/core/testing`): los GitHub y Linear falsos y la plantilla
// `juguete` del core de demo. Solo la usan los tests y el testkit; el core de producción no la importa.
export { startFakeLinear } from "./testing/linear/fake-linear";
export type { FakeLinear, FakeLinearOptions } from "./testing/linear/fake-linear";
export type { FakeIssue, FakeProject, FakeTeam, FakeWorkspace } from "./testing/linear/fake-workspace";
export { startFakeGitHubOAuth } from "./testing/github/fake-github-oauth";
export type { FakeGitHubOAuth, FakeGitHubOAuthOptions, FakeGitHubOAuthRequest } from "./testing/github/fake-github-oauth";
export { healthyGitHub, recorded, startFakeGitHub } from "./testing/github/fake-github";
export type { FakeGitHub, FakeRequest, RecordedResponse } from "./testing/github/fake-github";
export { defaultBranchChecksData, graphqlNotFound, prGraphql } from "./testing/github/fake-pr-graphql";
export type { DefaultBranchCommit } from "./testing/github/fake-pr-graphql";
export { JUGUETE_FLOW, JUGUETE_PROFILE, JUGUETE_ROLE, JUGUETE_TEMPLATE } from "./builtin/juguete";
