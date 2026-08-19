# `momi-decision-alert-delivery-v1`

- Route: `/functions/v1/momi-decision-alert-delivery-v1`
- `GET`: no-send configuration/policy preflight.
- `POST`: claim one capability-bound initial or resolution delivery.

Initial messages contain only the bounded fields from the authoritative Linear
decision record. Resolution messages reply once to the initial receipt thread.
Requests set `mrkdwn=false`, `parse=none`, and disable unfurls; structured
records containing channel, here, user, or user-group mentions are rejected
before persistence.
