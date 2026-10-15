# Offline navigation after a direct Add visit

Expo Router defaults to asynchronous routes on web. Keep `asyncRoutes.web`
disabled in `apps/mobile/app.json`: a cold direct `/add` visit must load the
Inbox code before a user can save and dismiss while offline (issue #939).
This deliberately trades a larger initial web bundle for navigation that does
not require downloading another route. Native route configuration is unchanged.
Best-effort route prefetch would leave a race if connectivity disappeared
before prefetch completed.

To verify a production web export, use a fresh browser context with backend
requests blocked. Open `/add` directly without first visiting `/`, paste an
image, then go offline and save. Assert that the Inbox renders the saved image,
the bookmark and create operation are durable, and dismissal makes no new
JavaScript requests. Reconnect and reload; assert that the same bookmark ID and
image bytes remain. Also check offline Close from a fresh direct `/add` visit.

This covers navigation within an already loaded app. It does not provide an
offline cold launch or establish that pending captures have uploaded.
