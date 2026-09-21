# Greenfield discovery

M21 introduces an adaptive, policy-driven discovery engine for new projects.

## Trigger

Use:

    LLMatic: Start Project Discovery

A repository containing only Git metadata, README/license/editor metadata is considered greenfield.

Discovery may also be run in an existing repository after an explicit warning. It still does not mutate tracked project files.

## Question model

Each discovery decision includes:

- prompt
- explicit options
- a best-practice recommendation
- recommendation rationale
- optional custom answer
- applicability rule for adaptive follow-up

User paths:

- choose an option directly
- Custom…
- Not sure — explain recommendation
- Let LLMatic decide

Not sure shows the rationale and still requires `Use Recommendation`.

Let LLMatic decide records that the choice was delegated together with the recommendation rationale.

## Current policy areas

- product type
- prototype / MVP / production target
- primary users
- application shape
- authentication
- tenancy / organizations
- primary persistence model
- deployment model
- testing baseline
- security posture

Questions are skipped when they do not apply. For example a local prototype CLI does not receive web authentication/tenancy/database questions that do not materially fit the selected shape.

## Persistence

Discovery is stored at:

    <managed-workspace>/planning/discovery.json

This is outside the tracked repository.

The persisted record includes:

- original project idea
- answer source
- answer value/label
- recommendation/delegation rationale
- timestamps
- discovery completion status

## Hard boundary

M21 has no scaffold/materialize action.

Before the later Approval & Initialization milestone, discovery cannot:

- create project source files
- install packages
- create database migrations
- push Git
- create PRs
- deploy

The completed state is only:

    ready_for_planning

M22 consumes this private discovery record to draft the project plan.
