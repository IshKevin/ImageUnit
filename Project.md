# Event Media Management & Distribution Platform

## 1. Project Overview

The company needs a centralized platform for managing, storing, distributing, and controlling photographs captured during events.

The company currently handles events where large numbers of photographs are produced. Photographers need a reliable way to upload these photographs, organize them under specific events, and share the resulting galleries with people who attended the events.

Attendees should be able to access an event through a shareable link, browse the available photographs, and download photographs when permitted.

The company also operates multiple websites that need access to these photographs. Therefore, the platform must provide a controlled way for authorized websites and systems to retrieve event and image information without directly accessing the platform's internal storage or database.

The platform will therefore serve as a **centralized event media management and distribution system**.

It combines three major capabilities:

1. **Photographer and event management**
2. **Public/private event galleries for attendees**
3. **A controlled media access layer for the company's other websites**

The platform must also provide administrators with centralized control over users, permissions, events, photographs, access, storage, and system activity.

---

# 2. Project Objectives

The primary objectives are to:

* Provide photographers with a centralized place to upload event photographs.
* Allow large numbers of photographs to be uploaded and managed efficiently.
* Organize photographs by events and galleries.
* Generate shareable links for events.
* Allow attendees to access event photographs without unnecessary complexity.
* Control how long event galleries remain accessible.
* Control whether photographs can be downloaded.
* Allow the company to manage multiple photographers and users.
* Give administrators centralized control over permissions and access.
* Ensure only authorized users can perform sensitive operations.
* Restrict permanent photograph deletion to administrators.
* Provide a centralized source of photographs for multiple company websites.
* Provide controlled programmatic access to photographs for authorized websites.
* Track important system activities.
* Monitor storage, usage, events, and user activity.
* Support future payment and commercial access models.
* Provide a foundation that can grow as the number of events, photographers, photographs, and websites increases.

---

# 3. Scope of the Platform

The platform will contain the following major areas:

```text
Event Media Platform
│
├── User Management
├── Access & Permissions
├── Photographer Management
├── Event Management
├── Gallery Management
├── Photograph Management
├── Public Event Galleries
├── Sharing & QR Codes
├── Download Management
├── Website/API Access
├── Storage Management
├── Analytics
├── Payment & Commercial Access
├── Notifications
├── Audit Logs
└── System Administration
```

---

# 4. User Types

The initial platform should support the following user types.

## 4.1 Administrator

The administrator has centralized control over the platform.

Administrators can:

* Create users.
* Edit users.
* Suspend users.
* Activate users.
* Assign roles.
* Manage permissions.
* Manage photographers.
* Manage events.
* View photographs.
* Delete photographs.
* Delete or archive events.
* Control access to events.
* Manage websites using the platform.
* Manage system settings.
* View system analytics.
* View audit logs.
* Manage storage policies.
* Manage commercial/payment settings.
* Override certain user-level restrictions when necessary.

The administrator is the highest-privilege user.

---

# 4.2 Photographer

The photographer is responsible for uploading and managing photographs for events.

A photographer can:

* Log into the platform.
* Create events if permitted.
* Edit their own events.
* Upload photographs.
* Organize photographs into galleries.
* Add event information.
* Generate event sharing links.
* Generate QR codes.
* Configure permitted gallery settings.
* View their own event statistics.
* View upload status.
* View photograph processing status.
* Manage photographs within the permissions assigned to them.

A photographer **cannot permanently delete photographs**.

Permanent photograph deletion is an administrator-only operation.

---

# 4.3 Attendee / Visitor

An attendee is a person accessing photographs from an event.

An attendee may not need to create an account.

Depending on the event configuration, an attendee can:

* Open an event link.
* View event information.
* Browse photographs.
* Search or filter photographs where supported.
* Open photographs.
* Download photographs where downloading is permitted.
* Share the event link.
* Access the event through a QR code.

The attendee should have the minimum amount of friction necessary to access public event photographs.

---

# 4.4 Website / External System

The company's other websites are treated as authorized clients of the platform.

An authorized website can retrieve information such as:

* Events.
* Galleries.
* Photograph metadata.
* Photograph URLs.
* Thumbnails.
* Preview images.
* Downloadable images where permitted.

Websites must not directly access the platform's internal database or storage.

Access must be controlled and revocable by administrators.

---

# 5. User Management

Administrators must have a complete user management area.

The administrator should be able to:

* Create users.
* View users.
* Search users.
* Filter users.
* Edit user information.
* Assign roles.
* Change account status.
* Suspend accounts.
* Reactivate accounts.
* Reset access where appropriate.
* View user activity.
* View events associated with a photographer.
* View permissions assigned to a user.

User statuses should include at least:

```text
Active
Suspended
Inactive
```

A suspended user must not be able to perform normal platform operations.

---

# 6. Role-Based Access Control

The platform must use role-based access control.

Permissions must be enforced on the server side.

Hiding a button in the interface is not considered sufficient security.

For example, if a photographer is not permitted to delete a photograph, attempting to directly access the deletion operation must still be rejected.

---

## 6.1 Example Permission Structure

### Administrator

Can:

* Manage users.
* Manage roles.
* Manage permissions.
* Manage photographers.
* Create and manage events.
* View all events.
* View all photographs.
* Delete photographs.
* Delete/archive events.
* Manage websites.
* Manage API access.
* View analytics.
* View audit logs.
* Manage system settings.

### Photographer

Can:

* Manage their permitted events.
* Upload photographs.
* View their photographs.
* Organize galleries.
* Manage event information.
* Share events.
* View statistics for their events.

Cannot:

* Manage users.
* Change system permissions.
* Delete photographs permanently.
* Delete other photographers' events.
* Manage external website access.
* Manage system settings.

### Attendee

Can:

* View permitted event galleries.
* View photographs.
* Download photographs if allowed.

Cannot:

* Upload photographs.
* Modify photographs.
* Modify events.
* Manage users.
* Access administrative functions.

---

# 7. Administrator Control Over Permissions

The administrator should be able to determine what users are allowed to access.

The permission system should support permissions such as:

```text
View Events
Create Events
Edit Events
Publish Events
Upload Images
Manage Galleries
View Statistics
Download Images
Manage Users
Manage Websites
Manage API Access
Delete Images
Delete Events
Manage System Settings
View Audit Logs
```

However, critical operations should remain protected.

For example:

> Permanent photograph deletion should be restricted to administrators.

This prevents accidental or unauthorized deletion of valuable event photographs.

---

# 8. Event Management

An event is the central organizational unit of the platform.

Each event should contain information such as:

* Event name.
* Event description.
* Event date.
* Event location.
* Event owner/photographer.
* Event status.
* Public access status.
* Gallery information.
* Sharing link.
* QR code.
* Access expiration date.
* Download policy.
* Visibility settings.
* Creation date.
* Last updated date.

Example:

```text
Event
────────────────────────
Kigali International Marathon 2026

Date:
20 June 2026

Location:
Kigali

Photographer:
John Photography

Status:
Active

Gallery Access:
Public

Downloads:
Allowed

Expiration:
20 July 2026
```

---

# 9. Event Status

Events should have defined lifecycle states.

Example:

```text
Draft
  ↓
Active
  ↓
Expired
  ↓
Archived
```

### Draft

The event is being prepared.

It is not publicly available.

### Active

The event is available to authorized visitors.

### Expired

The configured public access period has ended.

Visitors should no longer be able to access the event through the normal public link unless an administrator extends access.

### Archived

The event is retained for administrative or business purposes but is no longer publicly active.

---

# 10. Event Expiration

Every event should support an access period.

For example:

```text
Event created
     ↓
Photographs uploaded
     ↓
Event published
     ↓
Public access
     ↓
Expiration date
     ↓
Public access disabled
```

Expiration should disable public access without automatically destroying the photographs.

Administrators should be able to:

* Extend the event.
* Reactivate the event.
* Archive the event.
* Permanently delete the event where appropriate.

---

# 11. Gallery Management

An event may contain one or multiple galleries.

For example:

```text
Kigali Marathon 2026
│
├── Starting Line
├── Finish Line
├── Awards
├── Participants
└── General Event
```

A gallery should contain:

* Name.
* Description.
* Event.
* Photographs.
* Visibility.
* Download settings.
* Creation date.
* Update date.

---

# 12. Photograph Management

Photographs are the primary media objects managed by the platform.

Each photograph should have information such as:

* Unique identifier.
* Event.
* Gallery.
* Original file information.
* File size.
* Dimensions.
* Format.
* Upload date.
* Photographer.
* Processing status.
* Visibility status.
* Download availability.
* Metadata where available.

The system should distinguish between:

```text
Original Photograph
Preview Photograph
Thumbnail Photograph
```

This allows the platform to deliver the appropriate version depending on the use case.

---

# 13. Bulk Photograph Upload

Photographers must be able to upload large batches of photographs.

The upload process should support:

* Multiple files.
* Large files.
* Upload progress.
* Individual upload status.
* Failed upload identification.
* Retry capability.
* Upload cancellation where possible.
* Processing status.

Example:

```text
Uploading

1,247 / 2,000

Completed: 1,247
Failed: 3
Remaining: 750

[Retry Failed]
```

The photographer should not have to restart the entire upload because a small number of files failed.

---

# 14. Photograph Processing

After upload, photographs should go through processing.

The system should be capable of producing versions appropriate for:

* Gallery previews.
* Thumbnails.
* Website display.
* Full-resolution downloads.

Processing should happen independently from the user's browser session so that very large uploads do not require the photographer to keep the page open for the entire processing period.

The photographer should be able to see processing status.

Example:

```text
Uploaded
   ↓
Processing
   ↓
Ready
```

or:

```text
Uploaded
   ↓
Processing
   ↓
Failed
   ↓
Retry
```

---

# 15. Public Event Gallery

Every published event should be able to have a shareable link.

Example:

```text
Event:
Kigali Marathon 2026

Gallery:
https://photos.example.com/events/kigali-marathon-2026
```

The link should allow attendees to access the event according to the event's access settings.

The public gallery should provide:

* Event name.
* Event information.
* Photograph grid.
* Image preview.
* Download functionality where permitted.
* Sharing functionality.
* Gallery navigation.
* Mobile-friendly access.

---

# 16. QR Codes

Each event should optionally have a QR code.

The QR code points to the event's public gallery.

This is particularly useful at physical events.

For example:

```text
SCAN TO VIEW
EVENT PHOTOS

[QR CODE]

Kigali Marathon 2026
```

The photographer or administrator should be able to download or display the QR code.

---

# 17. Photograph Download Control

Each event should have download settings.

Examples:

```text
Downloads:
Allowed
```

or:

```text
Downloads:
Disabled
```

The platform may also distinguish between:

```text
Preview Download
Full Resolution Download
```

The event owner should only be able to change settings that their permissions allow.

Administrators must always have the ability to override event access settings.

---

# 18. Photograph Deletion

Photograph deletion must be treated as a sensitive operation.

### Photographer

Cannot permanently delete photographs.

### Attendee

Cannot delete photographs.

### External Website

Cannot delete photographs.

### Administrator

Can delete photographs.

When an administrator deletes a photograph, the action should be recorded.

Example:

```text
Administrator:
admin@example.com

Action:
Deleted Photograph

Photograph:
IMG_23891

Event:
Kigali Marathon 2026

Date:
29 September 2026
```

This ensures accountability.

---

# 19. Event Deletion

Event deletion should also be restricted.

Deleting an event may affect:

* Galleries.
* Photographs.
* Public links.
* Website integrations.
* Statistics.
* Payment records.

Therefore, event deletion should require administrator privileges.

The system should preferably provide an archive/deactivation mechanism before permanent deletion.

---

# 20. Audit Logs

The system must maintain an audit trail for important administrative and security-related actions.

Examples:

```text
User created
User suspended
User activated
Role changed
Permission changed
Event created
Event published
Event expired
Event archived
Photograph deleted
Event deleted
API client created
API access revoked
Payment status changed
Access settings changed
```

Each audit record should contain, where applicable:

* User who performed the action.
* Action.
* Object affected.
* Date/time.
* Previous value.
* New value.
* Relevant event.
* Relevant user.
* Additional context.

Audit logs should not be editable by normal users.

---

# 21. Website Integration

The company has multiple websites.

The platform must therefore provide controlled access to event photographs.

The websites should be able to request:

```text
Events
Galleries
Photographs
Thumbnails
Preview images
Permitted download resources
```

The website should not need direct access to the platform's internal storage.

---

# 22. Website Access Management

Administrators should be able to register and manage company websites.

For each website, the administrator should be able to:

* Register the website.
* Give it an identifiable name.
* Enable/disable access.
* Generate access credentials.
* Revoke access.
* View usage.
* Restrict available resources where necessary.

Example:

```text
Website:
Company Events Website

Status:
Active

Access:
Events
Galleries
Images

Created:
29 September 2026
```

If a website is compromised or no longer used, the administrator must be able to revoke its access without affecting other websites.

---

# 23. Media Access Layer

The platform should provide a controlled media access layer between the internal media system and external websites.

Conceptually:

```text
Company Website
       │
       │ Authorized request
       ▼
Media Platform
       │
       ├── Validate access
       ├── Check event
       ├── Check permissions
       └── Return permitted media
```

External websites should never need to know how the internal media storage is organized.

This makes it possible to change the underlying storage later without requiring changes to every website.

---

# 24. Access Security

The platform must distinguish between:

```text
Public Access
Authenticated User Access
Photographer Access
Administrator Access
Website/System Access
```

Each type of access must have its own permissions.

A public visitor should not be able to discover administrative resources simply by changing a URL.

Similarly, a photographer must not be able to access another photographer's private events.

---

# 25. Storage Management

The platform must track media storage usage.

Administrators should be able to see:

```text
Total storage
Used storage
Available storage
Storage by event
Storage by photographer
Storage by website
```

Example:

```text
Storage Overview

Total:      10 TB
Used:       6.4 TB
Available:  3.6 TB

Photographers:
John       1.2 TB
Peter      890 GB
David      640 GB
```

This is important because event photography can produce very large amounts of data.

---

# 26. Media Retention

The platform should define what happens to old event photographs.

Possible states:

```text
Active
Expired
Archived
Scheduled for deletion
Deleted
```

The company should be able to establish retention rules.

For example:

```text
Public gallery:
30 days

Archived media:
Retained for 12 months

After retention:
Administrator reviews before permanent deletion
```

The exact periods should be configurable according to the company's business requirements.

---

# 27. Analytics

The platform should provide statistics for administrators.

At minimum:

### Platform statistics

* Number of users.
* Number of photographers.
* Number of events.
* Number of photographs.
* Storage usage.
* Number of active galleries.
* Number of expired galleries.
* Number of downloads.
* Number of visitors.

### Event statistics

* Event views.
* Unique visitors where measurable.
* Photograph views.
* Downloads.
* Number of photographs.
* Storage used.
* Gallery activity.

### Photographer statistics

* Number of events.
* Number of photographs uploaded.
* Storage used.
* Gallery views.
* Downloads.

---

# 28. Payment and Commercial Access

The platform should be designed to support paid events and access.

There are potentially two business models.

### Model A — Event owner pays

A photographer or organization pays to create/maintain an event.

Example:

```text
Event package

Storage allowance
Gallery duration
Number of photographs
Access period
```

### Model B — Attendee pays

Attendees may pay for:

* Individual photographs.
* Full-resolution downloads.
* Complete event access.
* Premium galleries.

The exact commercial model can be finalized separately.

The project should not assume that every event uses the same payment model.

---

# 29. Payment Status

Where payment is required, the system should support statuses such as:

```text
Pending
Paid
Failed
Cancelled
Refunded
Expired
```

Access should be granted or restricted according to the payment rules configured for that event or service.

---

# 30. Notifications

The platform should be capable of sending relevant notifications.

Examples:

### Photographer

* Upload completed.
* Upload failed.
* Processing completed.
* Event expired.
* Event approaching expiration.
* Payment received.
* Storage limit approaching.

### Administrator

* Storage threshold reached.
* Processing failures.
* Suspicious access activity.
* Payment failures.
* System errors.

Notifications can be expanded as the platform grows.

---

# 31. Search and Filtering

The platform should support search where appropriate.

Administrators should be able to search:

* Users.
* Photographers.
* Events.
* Galleries.
* Photographs.

Photographers should be able to search their own events and galleries.

Attendees should be able to search/filter photographs according to the functionality available for the event.

---

# 32. User Experience Requirements

The platform should be simple enough that a photographer does not need technical knowledge to use it.

The normal photographer workflow should be:

```text
Login
  ↓
Create Event
  ↓
Upload Photos
  ↓
Wait for Processing
  ↓
Review Gallery
  ↓
Publish Event
  ↓
Get Link / QR Code
  ↓
Share With Attendees
```

The attendee workflow should be:

```text
Receive Link / Scan QR
        ↓
Open Event
        ↓
Browse Photos
        ↓
Open Photo
        ↓
Download if Allowed
```

The administrator workflow should be:

```text
Login
  ↓
Monitor Platform
  ↓
Manage Users
  ↓
Manage Events
  ↓
Manage Access
  ↓
Monitor Storage
  ↓
Review Activity
  ↓
Handle Issues
```

---

# 33. Security Requirements

The platform must provide:

* Secure authentication.
* Role-based authorization.
* Server-side permission enforcement.
* Account suspension.
* Controlled website access.
* Access credential management.
* Rate limiting.
* Upload validation.
* File validation.
* Protection against unauthorized media access.
* Audit logging.
* Secure administrative operations.
* Protection of private event galleries.
* Controlled access to original photographs.

Security must be applied to both the user interface and backend operations.

---

# 34. Data Protection

The platform will potentially contain photographs of real people.

The company should therefore define:

* Who owns uploaded photographs.
* Who is allowed to access them.
* How long photographs are retained.
* When photographs are deleted.
* Who can download original files.
* Whether public sharing is allowed.
* How private events are protected.
* How user information is stored.
* How access is revoked.

These rules should be documented before production launch.

---

# 35. Reliability Requirements

The system should be designed so that a failure in one part does not unnecessarily destroy or corrupt uploaded photographs.

For example:

If photograph processing fails:

```text
Photograph
    ↓
Processing Failed
    ↓
Retry
```

The original uploaded photograph should not be lost simply because a generated preview failed.

Similarly, an expired event should not automatically mean that the underlying photograph data has been destroyed.

---

# 36. Backup and Recovery

The project is not considered production-ready without a defined backup and recovery process.

The company must have a documented approach for:

* User data backup.
* Event data backup.
* Photograph backup.
* Database recovery.
* Media recovery.
* Recovery after accidental deletion.
* Recovery after infrastructure failure.

The company should periodically test whether backups can actually be restored.

A backup that has never been tested should not be considered a reliable recovery plan.

---

# 37. Operational Monitoring

Administrators should be able to identify problems with:

* Uploads.
* Photograph processing.
* Storage.
* User authentication.
* Website access.
* API usage.
* Event access.
* Payments.
* System errors.

The system should make important failures visible rather than requiring someone to discover them manually.

---

# 38. MVP Scope

The first production version should contain:

### User Management

* Administrator accounts.
* Photographer accounts.
* User status.
* Roles.
* Permissions.
* Account suspension.

### Events

* Create events.
* Edit events.
* Publish events.
* Expire events.
* Archive events.
* Event links.

### Photography

* Bulk upload.
* Upload progress.
* Image processing.
* Thumbnails.
* Galleries.
* Image previews.
* Download control.

### Public Access

* Public event links.
* Gallery browsing.
* Image viewing.
* Download where permitted.
* QR codes.

### Administration

* User management.
* Event management.
* Photograph management.
* Administrator-only deletion.
* Storage monitoring.
* Basic analytics.
* Audit logs.

### Website Integration

* Website registration.
* Website access credentials.
* Event retrieval.
* Gallery retrieval.
* Photograph retrieval.
* Access revocation.

---

# 39. Features That Can Come After MVP

The following should be considered future capabilities rather than requirements for the first release:

* Advanced attendee accounts.
* Facial/photo-based search.
* Advanced watermarking.
* Advanced payment models.
* Individual photograph purchasing.
* Automated invoicing.
* Advanced marketing tools.
* Advanced photographer subscriptions.
* Advanced reporting.
* Multiple organizations/tenants.
* Advanced image editing.
* Advanced event branding.
* Promotional tools.

These should not delay the initial platform unless they are part of the company's immediate business requirements.

---

# 40. Definition of Done

The project should only be considered complete when the following end-to-end workflows work correctly.

## Photographer

A photographer can:

* Log in.
* Create an event.
* Upload a large batch of photographs.
* See upload progress.
* See processing status.
* Organize photographs.
* Review the gallery.
* Publish the event.
* Generate a link.
* Generate a QR code.
* Share the event.

## Attendee

An attendee can:

* Open the event link.
* View the event.
* Browse photographs.
* Open individual photographs.
* Download photographs when permitted.
* Access the gallery from a mobile device.

## Administrator

An administrator can:

* Create and manage users.
* Assign roles.
* Manage permissions.
* Suspend users.
* Manage photographers.
* Manage events.
* View all photographs.
* Delete photographs.
* Archive events.
* Control access.
* Manage website clients.
* Revoke website access.
* View system statistics.
* Monitor storage.
* Review audit logs.

## Website

An authorized company website can:

* Authenticate with the platform.
* Retrieve permitted events.
* Retrieve galleries.
* Retrieve photographs.
* Display photographs to its users.
* Respect event access rules.

## Security

The system must demonstrate that:

* A photographer cannot access another photographer's private event.
* A photographer cannot permanently delete photographs.
* An attendee cannot access administrative functions.
* An external website cannot access unauthorized media.
* A suspended user cannot continue normal platform operations.
* Revoked website access stops further access.
* Sensitive administrative actions are logged.

## Reliability

The system must demonstrate that:

* Failed uploads can be identified and retried.
* Failed image processing can be retried.
* Expiring an event does not accidentally destroy its photographs.
* Backups can be restored.
* Important system failures can be identified.
* Storage usage can be monitored.

---

# 41. Final Product Definition

The completed product is a **centralized event photography management and media distribution platform**.

It will allow the company to move from:

```text
Photographer
     ↓
Upload photos
     ↓
Random/manual storage
     ↓
Manually share photos
     ↓
Different websites manage their own images
```

to:

```text
                    EVENT MEDIA PLATFORM
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
  Photographer          Attendee             Company
     Portal              Gallery              Websites
        │                    │                    │
        ▼                    ▼                    ▼
     Upload              Browse              Retrieve
     Manage              Download             Images
     Events              Share                through
                                              controlled
                                                access
        │                    │                    │
        └────────────────────┼────────────────────┘
                             ▼
                    Centralized Media
                        Management
                             │
                ┌────────────┼────────────┐
                ▼            ▼            ▼
             Events       Images       Access
                │            │            │
                └────────────┼────────────┘
                             ▼
                         Administrator
```

The **administrator remains the central authority** for users, permissions, sensitive operations, and system governance.

Most importantly, the platform should not simply be considered finished because "the website works." It is finished when the **complete business workflow works safely from photograph upload → processing → event publication → attendee access → website integration → expiration → administration → retention/deletion**, with appropriate permissions, auditability, backups, and operational controls.
