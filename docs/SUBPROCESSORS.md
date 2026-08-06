# Subprocessors

Third parties that may process customer personal data on behalf of a LogicFlower deployment.

This register exists because subprocessor disclosure is a contractual and regulatory obligation, not a courtesy, and because a customer's own DPA with *their* customers usually requires them to be able to produce this list on request.

> **Status: template, not a filed record.** The entries below describe the subprocessors this software is *capable* of using. Which are actually engaged depends on how a given deployment is configured, and no deployment has yet been assessed. Every row must be confirmed, dated, and countersigned by the accountable person before this document is shown to a customer or attached to a DPA. A subprocessor list that has not been checked is worse than none, because it will be relied upon.

## Always engaged

| Subprocessor | Purpose | Data categories | Location |
|---|---|---|---|
| Application hosting provider | Runs the API, worker and web containers | All customer data in transit and in memory | *To be recorded per deployment* |
| MongoDB hosting (self-managed or Atlas) | Primary datastore | Contacts, workflow definitions, execution records, encrypted credentials, audit events | *To be recorded per deployment* |
| Redis hosting | Queue and coordination state | Job identifiers, correlation identifiers, rate-limit counters. No customer records at rest. | *To be recorded per deployment* |
| Object storage (S3 or compatible) | Encrypted artefacts: batch sources, failed-record exports, before-state, vault exports | Contact records inside encrypted artefacts | *To be recorded per deployment* |

## Engaged when configured

| Subprocessor | Purpose | Data categories | Engaged when |
|---|---|---|---|
| Stripe | Subscription billing | Billing contact, organisation name, payment metadata. **No contact records.** | Billing enabled |
| SMTP provider | Transactional email | Recipient email addresses, notification content | `SMTP_HOST` configured |
| AWS KMS | Wraps data-encryption keys | **No customer data.** Key material only. | `KMS_PROVIDER=aws-kms` |
| AWS Secrets Manager / HashiCorp Vault | Runtime secret storage | **No customer data.** Configuration secrets only. | `SECRET_STORE_DRIVER` set |

## Customer-directed processors

These are engaged by the customer's own action — connecting an account or supplying an API key — rather than by the operator. They are listed because the customer's regulator will not care about that distinction.

| Processor | Purpose | Data categories | Engaged when |
|---|---|---|---|
| HighLevel, HubSpot, Klaviyo, ActiveCampaign | The customer's own CRM, read and written on their instruction | Whatever the customer's account contains | The customer connects it |
| Google Sheets | Governed one-directional row operations | Rows the customer maps | The customer connects it |
| OpenAI, Anthropic, Google AI | Structured AI workflow steps under bring-your-own-key | Only the fields the customer's prompt template references | The customer supplies a key **and** an owner records explicit consent |

### The AI case is different, and deliberately so

An AI provider receives customer personal data and is a subprocessor under GDPR and the DPDP Act. The system therefore records a per-connection consent decision by an organisation owner before any data leaves for a model provider, and stores that record. Consent is not inferred from the presence of an API key.

This is the one subprocessor relationship the software enforces rather than merely documents.

## Change notification

Customers must be given advance notice of a new subprocessor with an opportunity to object — typically 30 days, but the actual period is whatever the signed DPA says. Confirm against the agreements in force rather than against this paragraph.

## Before this document is used

- [ ] Confirm each hosting and storage provider actually engaged, with region
- [ ] Record the data-processing agreement in force with each
- [ ] Confirm the transfer mechanism for any provider outside the customer's jurisdiction
- [ ] Have counsel review the register against the customer-facing DPA
- [ ] Date it, name the accountable person, and set a review interval

Until every box is ticked this file is engineering documentation, not a legal artefact.
