# Data protection policy — decisions required before launch

Photographs of real people are personal data. Project.md §34 requires the company to decide the following **before production launch**. The platform enforces whatever is decided; it cannot decide for you. Fill in the right-hand column.

| Question | Platform capability | Decision |
|---|---|---|
| Who owns uploaded photographs? | Each event has one owner (photographer); administrators can transfer. | _TBD (contract)_ |
| Who may access them? | Owner + administrators; attendees only via the event link; websites only via scoped credentials. | _TBD_ |
| How long are galleries public? | `defaultAccessDays` (default 30), per-event expiry. | _TBD_ |
| How long is archived media retained? | `archiveRetentionMonths` (default 12) then admin review. | _TBD_ |
| When are photos deleted? | Only by an administrator; audited. | _TBD_ |
| Who can download originals? | Per event: disabled / preview / full; galleries and photos can only restrict. | _TBD_ |
| Is public sharing allowed? | Per event: public / unlisted / password-protected. | _TBD_ |
| How is user data stored? | Name, email, argon2id password hash; visitors are never stored as IPs (daily-rotating salted hash for unique counts). | _TBD_ |
| How is access revoked? | Suspend user (immediate), revoke website credential (immediate), unpublish/archive event, change gallery password. | _TBD_ |
| Takedown requests from people in photos | Photographers can hide a photo immediately; administrators can permanently delete it. Define the response-time SLA. | _TBD_ |
