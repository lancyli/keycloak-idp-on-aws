# USAGE-GUIDE — Keycloak realm + Amazon Quick / QuickSight SSO federation

This is the **one-time post-deploy configuration** for the HA Keycloak deployed by this
CDK project (Keycloak 26.x). The CDK provisions Keycloak itself; the realm, clients,
mappers, and the AWS-side IAM SAML provider are configured here.

Two federation paths are covered:

- **Amazon Quick Desktop** → **OIDC** public client (PKCE).
- **Amazon Quick / QuickSight Web console** → **SAML 2.0** client federating into AWS
  sign-in (`https://signin.aws.amazon.com/saml`).

Throughout, replace these placeholders:

| Placeholder | Meaning | Example |
|-------------|---------|---------|
| `<KEYCLOAK_URL>` | `keycloak-ha-cloudfront.KeycloakPublicUrl` output | `https://d111111abcdef8.cloudfront.net` |
| `<ACCOUNT_ID>` | Customer AWS account id | `123456789012` |
| `<REALM>` | Realm name | `aws-realm` |
| `<SAML_PROVIDER>` | IAM SAML provider name | `keycloak` |
| `<FED_ROLE>` | IAM role users federate into | `keycloak-quicksight-federation` |

> **AWS China (ZHY):** every `signin.aws.amazon.com` becomes `signin.amazonaws.cn`,
> every `arn:aws:` becomes `arn:aws-cn:`, and the SAML audience changes accordingly.
> See the "ZHY adaptation notes" in `README.md`.

---

## 0. Prerequisites

Get the admin password and base URL produced by the deploy:

```bash
# Public base URL
aws cloudformation describe-stacks --stack-name keycloak-ha-cloudfront \
  --region us-west-2 --query "Stacks[0].Outputs[?OutputKey=='KeycloakPublicUrl'].OutputValue" \
  --output text

# Admin password (username is 'admin')
aws secretsmanager get-secret-value --secret-id keycloak-ha/keycloak/admin \
  --region us-west-2 --query SecretString --output text
```

Log in at `<KEYCLOAK_URL>/admin/` as `admin`.

---

## 1. Create the realm

**Admin console** → realm switcher (top-left) → **Create realm**.

- Realm name: `aws-realm`
- Create.

Then **Realm settings**:

- **General** → leave display name as desired.
- **Login** → enable **Brute force detection** (Realm settings → Security defenses →
  Brute force detection → On).
- **Sessions/Tokens** → keep defaults; SAML assertion lifespan should be ≥ the AWS
  `SessionDuration` you set below.

`sslRequired` is `external` by default in 26.x (HTTPS enforced for non-private
addresses), which matches the CloudFront HTTPS front door — no change needed.

Create at least one test user: **Users → Add user**, then **Credentials → Set password**
(turn *Temporary* off for a test account).

---

## 2. Amazon Quick Desktop — OIDC public client

**Clients → Create client**.

- Client type: **OpenID Connect**
- Client ID: `amazon-quick-desktop`
- Next.
- **Client authentication: Off** (public client).
- **Standard flow: On**; Direct access grants: Off.
- Next.
- **Valid redirect URIs** (loopback + custom scheme used by the desktop client):
  - `http://localhost/*`
  - `http://127.0.0.1/*`
  - `quick://callback`
- **Valid post logout redirect URIs**: same as above (or `+`).
- Save.

**Advanced → Proof Key for Code Exchange (PKCE)**: set **Code challenge method = S256**.

Discovery / endpoints the desktop client consumes:

```
Issuer:        <KEYCLOAK_URL>/realms/aws-realm
Discovery:     <KEYCLOAK_URL>/realms/aws-realm/.well-known/openid-configuration
Authorization: <KEYCLOAK_URL>/realms/aws-realm/protocol/openid-connect/auth
Token:         <KEYCLOAK_URL>/realms/aws-realm/protocol/openid-connect/token
```

Verify:

```bash
curl -s <KEYCLOAK_URL>/realms/aws-realm/.well-known/openid-configuration | jq .issuer
# -> "<KEYCLOAK_URL>/realms/aws-realm"
```

---

## 3. Amazon Quick / QuickSight Web — SAML client

This makes Keycloak a SAML IdP for the AWS sign-in endpoint.

**Clients → Create client**.

- Client type: **SAML**
- Client ID: `urn:amazon:webservices`  *(this is the SAML `entityId`/audience AWS expects)*
- Next.
- **Valid redirect URIs / Assertion Consumer Service POST Binding URL**:
  `https://signin.aws.amazon.com/saml`
  *(China: `https://signin.amazonaws.cn/saml`)*
- Save.

**Client → Settings**:

- **Name ID format**: `persistent` (or `email` if you key AWS sessions on email).
- **Force POST binding**: On.
- **Sign assertions**: On (Keycloak signs with the realm key by default).
- **Client signature required**: Off (AWS does not sign its AuthnRequests).

### 3a. Required AWS SAML attribute mappers

**Client → Client scopes →** `urn:amazon:webservices-dedicated` **→ Add mapper →
By configuration**, add the three mappers AWS requires:

**(i) Role (which IAM role(s) the user may assume)** — *Role list* mapper:

| Field | Value |
|-------|-------|
| Mapper type | Role list |
| Name | `aws-role` |
| Role attribute name | `https://aws.amazon.com/SAML/Attributes/Role` |
| Friendly name | `Role` |
| SAML attribute NameFormat | `Basic` |

The attribute **value** must be the pair `<role_arn>,<provider_arn>`:

```
arn:aws:iam::<ACCOUNT_ID>:role/<FED_ROLE>,arn:aws:iam::<ACCOUNT_ID>:saml-provider/<SAML_PROVIDER>
```

Map it from a Keycloak role: create a realm role (e.g. `quicksight-user`), set its
**Role attribute** description to the pair above, assign users to it. (Alternatively use
a hardcoded-attribute mapper if all users assume one role.)

**(ii) RoleSessionName** — *User Property* mapper:

| Field | Value |
|-------|-------|
| Mapper type | User Property |
| Name | `aws-session-name` |
| Property | `username` (or `email`) |
| SAML attribute name | `https://aws.amazon.com/SAML/Attributes/RoleSessionName` |
| NameFormat | `Basic` |

**(iii) SessionDuration** — *Hardcoded attribute* mapper:

| Field | Value |
|-------|-------|
| Mapper type | Hardcoded attribute |
| Name | `aws-session-duration` |
| SAML attribute name | `https://aws.amazon.com/SAML/Attributes/SessionDuration` |
| Attribute value | `3600` (seconds; ≤ the role's max session duration) |
| NameFormat | `Basic` |

### 3b. Export the IdP metadata

Download the realm's SAML descriptor (needed to create the IAM provider):

```bash
curl -s <KEYCLOAK_URL>/realms/aws-realm/protocol/saml/descriptor -o keycloak-idp-metadata.xml
```

---

## 4. AWS side — IAM SAML provider + federation role

### 4a. Create the SAML identity provider

```bash
aws iam create-saml-provider \
  --name <SAML_PROVIDER> \
  --saml-metadata-document file://keycloak-idp-metadata.xml
# note the returned SAMLProviderArn:
# arn:aws:iam::<ACCOUNT_ID>:saml-provider/<SAML_PROVIDER>
```

### 4b. Create the federation role

`trust-policy.json` — trusts the SAML provider for the AWS sign-in audience:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:saml-provider/<SAML_PROVIDER>"
      },
      "Action": "sts:AssumeRoleWithSAML",
      "Condition": {
        "StringEquals": {
          "SAML:aud": "https://signin.aws.amazon.com/saml"
        }
      }
    }
  ]
}
```

```bash
aws iam create-role --role-name <FED_ROLE> \
  --assume-role-policy-document file://trust-policy.json \
  --max-session-duration 3600
```

Attach **least-privilege** QuickSight permissions (tighten for production — do not ship
`quicksight:*`):

```bash
# Example only — scope down to the specific QuickSight actions/resources you need.
aws iam put-role-policy --role-name <FED_ROLE> --policy-name quicksight-access \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["quicksight:CreateUser", "quicksight:RegisterUser"],
      "Resource": "*"
    }]
  }'
```

The `arn:aws:iam::<ACCOUNT_ID>:role/<FED_ROLE>` here **must match** the role ARN you put
in the Keycloak Role attribute (step 3a-i).

---

## 5. Test the SAML flow

1. **IdP-initiated**: open
   `<KEYCLOAK_URL>/realms/aws-realm/protocol/saml/clients/urn:amazon:webservices`
   in a browser, log in as your test user → you should land on the AWS console signed in
   as the federated role.
2. If you see *"Your request included an invalid SAML response"*, check (in order): the
   Role attribute pair order is `role,provider`; the provider metadata is current; the
   assertion is signed; `SAML:aud` matches the ACS URL.
3. For QuickSight specifically, the first federated sign-in provisions the QuickSight user
   (subject to the role policy); then route users to the QuickSight start URL.

---

## 6. Optional: automate the realm (instead of console clicks)

For repeatable customer rollouts, export the configured realm and re-import it, or drive
`kcadm.sh` from a one-shot Kubernetes Job:

```bash
# Inside a keycloak pod:
kubectl -n keycloak exec -it deploy/keycloak -- \
  /opt/keycloak/bin/kcadm.sh config credentials \
    --server http://localhost:8080 --realm master \
    --user admin --password "$KEYCLOAK_ADMIN_PASSWORD"

# Export the fully configured realm to a file you can version and re-import:
kubectl -n keycloak exec -it deploy/keycloak -- \
  /opt/keycloak/bin/kcadm.sh get realms/aws-realm/partial-export \
    -r aws-realm > aws-realm-export.json
```

Re-import on a fresh deployment with `kcadm.sh create realms -f aws-realm-export.json`
(or `keycloak-config-cli`). This turns the manual steps above into a single artifact you
ship with the project.

---

## Summary checklist

- [ ] Realm `aws-realm` created, brute-force protection on, test user created.
- [ ] OIDC public client `amazon-quick-desktop` with PKCE S256 + loopback/`quick://` redirects.
- [ ] SAML client `urn:amazon:webservices`, ACS `https://signin.aws.amazon.com/saml`.
- [ ] Three SAML mappers: Role (`role,provider` pair), RoleSessionName, SessionDuration.
- [ ] IAM SAML provider created from `keycloak-idp-metadata.xml`.
- [ ] IAM federation role with `sts:AssumeRoleWithSAML` trust + least-privilege QuickSight policy.
- [ ] Role ARN in Keycloak matches the IAM role ARN.
- [ ] SAML test sign-in into the AWS console succeeds.
