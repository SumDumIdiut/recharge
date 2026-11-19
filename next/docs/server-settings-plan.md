# Server settings: categories, roles, server emoji arsenals

Decisions (user, 2026-11-19): roles = **name + colour (+admin flag)**; emojis = **a server owns an emoji
set; joining the server unlocks those emojis into your personal arsenal forever, usable anywhere, and all
emojis still render for everyone**.

## Data model (Recharge.Server, new records + stores)
- `ChannelRec.CategoryId` (string, "" = uncategorised). Back-compatible (old rows → "").
- `CategoryRec { Id "cat:..", ServerId, Name, Position, Created }` → `categories.jsonl`.
- `RoleRec { Id "role:..", ServerId, Name, Color, Admin(bool), Position, Created }` → `roles.jsonl`.
- `MemberRoleRec { Key serverId|userId, ServerId, UserId, RoleIds[] }` → `memberroles.jsonl`.
- `ServerEmojiRec { Key serverId|shortcode, ServerId, Shortcode }` → `serveremojis.jsonl`.
- `ArsenalRec { UserId (key), Shortcodes[] }` → `arsenal.jsonl`. The picker's set.
- Keep global `_emojis` (EmojiRec) as the universal **render** registry — unchanged, everyone resolves every shortcode.

## Management rights
`CanManage(me, s)` = owner OR a member holding a role with `Admin=true`. Owner-only stays only for delete-server.

## Endpoints (all under /api/servers/{id}; manage = CanManage)
- PATCH /api/servers/{id} {name?, icon?}                      (exists) rename / icon
- POST   /categories {name}                                   create category
- PATCH  /categories/{catId} {name?, position?}               rename / reorder
- DELETE /categories/{catId}                                  delete (its channels → "")
- PATCH  /channels/{chId} {name?, topic?, position?, categoryId?}  (extend) move channel into a category
- POST   /roles {name, color, admin}                          create role
- PATCH  /roles/{roleId} {name?, color?, admin?, position?}   edit role
- DELETE /roles/{roleId}                                      delete + unassign everywhere
- PUT    /members/{username}/roles {roleIds:[]}               set a member's roles
- GET    /emojis                                              this server's emoji set
- POST   /emojis {shortcode, mime, data}                      add (registry + server set + grant to all members' arsenals)
- DELETE /emojis/{shortcode}                                  remove from the server set (arsenals keep it — it's theirs now)
- GET /api/emojis            (exists) FULL registry → rendering (CUSTOM_EMOJIS), unchanged
- GET /api/emojis/mine       the caller's arsenal shortcodes → the picker's Custom tab

## Grant-on-join
`AddServerMember` / accept-invite: arsenal(joiner) ∪= server's emoji shortcodes (persisted, kept on leave).
Personal `UploadEmoji` (existing "upload your own permanent emojis") also adds the shortcode to the uploader's arsenal.

## ServerView / ChannelView additions
- ChannelView += `categoryId`.
- ServerView += `categories:[{id,name,position}]`, `roles:[{id,name,color,admin,position}]`;
  member shaping += `roles:[roleId]`, `admin = owner || any assigned role.Admin`.

## Client
- `social/api.ts`: category CRUD, role CRUD, member-roles set, server-emoji list/add/remove, `myArsenal()`, extend `renameChannel`/move with categoryId, `renameServer`.
- `social/model.ts`: Category, Role types; Server += categories/roles; Member += roles/admin (admin already there).
- `social/messages.ts`: replace kind-grouping with **real categories** (uncategorised group first, then each category by position; text/voice mix); the `+` on a category header still adds a channel *into that category*; add **New category** affordance + **rename category** (double-click / context). Apply role colour to member names + channel authors. New **Server settings modal** (owner/admin): Overview (name/icon), Roles (create/edit/colour/admin/assign), Emojis (add/remove, shows "members get these on join").
- `social/emojiPicker.ts`: Custom tab shows the **arsenal** (not the whole registry); personal upload adds to arsenal.
</content>
