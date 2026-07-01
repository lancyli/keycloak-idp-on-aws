# USAGE-GUIDE — Keycloak realm + SAML/OIDC federation (AWS ZHY / ZHY)

One-time post-deploy configuration for the HA Keycloak deployed by this CDK project in
**cn-northwest-1** (Keycloak 26.x). The CDK provisions Keycloak; the realm, clients,
mappers, and the AWS-side IAM SAML provider are configured here.

**This is the AWS ZHY (`aws-cn`) variant.** Every AWS sign-in endpoint is
`signin.amazonaws.cn` (NOT `.com`) and every ARN is `arn:aws-cn:...`. The public entry is
the **ALB** (no CloudFront).

Replace these placeholders:

| Placeholder | Meaning | Example |
|-------------|---------|---------|
| `<KC_URL>` | ALB-fronted base URL (stack output `AlbDnsName`, or your ICP domain) | `https://idp.example.cn` or `http://k8s-...elb.cn-northwest-1.amazonaws.com.cn` |
| `<CN_ACCOUNT_ID>` | Customer AWS ZHY account id | `123456789012` |
| `<REALM>` | Realm name | `aws-realm` |
| `<SAML_PROVIDER>` | IAM SAML provider name | `keycloak` |
| `<FED_ROLE>` | IAM role users federate into | `keycloak-quicksight-federation` |

---

## 0. Prerequisites

```bash
# ALB DNS name (public entry)
aws cloudformation describe-stacks --stack-name keycloak-ha-cn-eks \
  --region cn-northwest-1 --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" \
  --output text

# Admin password (username is 'admin')
aws secretsmanager get-secret-value --secret-id keycloak-ha-cn/keycloak/admin \
  --region cn-northwest-1 --query SecretString --output text
```

Log in at `<KC_URL>/admin/` as `admin`.

> If the admin console shows a loading / "something went wrong" error, `KC_HOSTNAME` is
> not yet pinned. Set `keycloak.publicUrl` in `lib/config.ts` to `<KC_URL>` and redeploy
> (`npx cdk deploy keycloak-ha-cn-eks`). See README "HTTPS / KC_HOSTNAME (two-phase)".

---

## 1. Create the realm

Admin console → realm switcher → **Create realm** → name `aws-realm` → Create.

- **Realm settings → Security defenses → Brute force detection**: On.
- `sslRequired` is `external` by default (HTTPS enforced for non-private addresses) — keep
  it when you front the ALB with an ACM cert / ICP domain. For HTTP-only testing you may
  temporarily set it to `none`.
- Create a test user (**Users → Add user**, then **Credentials → Set password**, *Temporary* off).

---

## 2. Amazon Quick Desktop — OIDC public client

**Clients → Create client**

- Type: **OpenID Connect**, Client ID: `amazon-quick-desktop` → Next
- **Client authentication: Off** (public), **Standard flow: On** → Next
- **Valid redirect URIs**: `http://localhost/*`, `http://127.0.0.1/*`, `quick://callback`
- Save → **Advanced → PKCE → Code challenge method = S256**

Endpoints:

```
Issuer:    <KC_URL>/realms/aws-realm
Discovery: <KC_URL>/realms/aws-realm/.well-known/openid-configuration
```

---

## 3. Amazon Quick / QuickSight Web — SAML client

**Clients → Create client**

- Type: **SAML**, Client ID: `urn:amazon:webservices` (the SAML audience AWS expects) → Next
- **ACS / Valid redirect URI**: `https://signin.amazonaws.cn/saml`  ← **ZHY endpoint**
- Save.

**Client → Settings**:

- Name ID format: `persistent` (or `email`).
- Force POST binding: On. Sign assertions: On. Client signature required: Off.

### 3a. Required AWS SAML attribute mappers

Under the client's dedicated scope → **Add mapper → By configuration**:

**(i) Role** — *Role list* mapper:

| Field | Value |
|-------|-------|
| Name | `aws-role` |
| SAML attribute name | `https://aws.amazon.com/SAML/Attributes/Role` |
| NameFormat | `Basic` |

Value is the pair `<role_arn>,<provider_arn>` using the **aws-cn** partition:

```
arn:aws-cn:iam::<CN_ACCOUNT_ID>:role/<FED_ROLE>,arn:aws-cn:iam::<CN_ACCOUNT_ID>:saml-provider/<SAML_PROVIDER>
```

**(ii) RoleSessionName** — *User Property* mapper:

| Field | Value |
|-------|-------|
| Property | `username` (or `email`) |
| SAML attribute name | `https://aws.amazon.com/SAML/Attributes/RoleSessionName` |
| NameFormat | `Basic` |

**(iii) SessionDuration** — *Hardcoded attribute* mapper:

| Field | Value |
|-------|-------|
| SAML attribute name | `https://aws.amazon.com/SAML/Attributes/SessionDuration` |
| Attribute value | `3600` (≤ the role's max session duration) |
| NameFormat | `Basic` |

> The SAML **attribute names** above stay `aws.amazon.com/...` even in ZHY — they are
> fixed AWS SAML claim keys. Only the **ACS endpoint** and the **ARNs** change to the
> ZHY values.

### 3b. Export the IdP metadata

```bash
curl -s <KC_URL>/realms/aws-realm/protocol/saml/descriptor -o keycloak-idp-metadata.xml
```

---

## 4. AWS ZHY side — IAM SAML provider + federation role

### 4a. Create the SAML provider

```bash
aws iam create-saml-provider \
  --name <SAML_PROVIDER> \
  --saml-metadata-document file://keycloak-idp-metadata.xml \
  --region cn-northwest-1
# returns: arn:aws-cn:iam::<CN_ACCOUNT_ID>:saml-provider/<SAML_PROVIDER>
```

### 4b. Create the federation role

`trust-policy.json` (note `arn:aws-cn` and the **ZHY** SAML audience):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws-cn:iam::<CN_ACCOUNT_ID>:saml-provider/<SAML_PROVIDER>"
      },
      "Action": "sts:AssumeRoleWithSAML",
      "Condition": {
        "StringEquals": {
          "SAML:aud": "https://signin.amazonaws.cn/saml"
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

# Attach least-privilege QuickSight permissions (scope down for production):
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

The role ARN here **must match** the role ARN in the Keycloak Role attribute (step 3a-i).

> **Verify QuickSight availability** in cn-northwest-1 before relying on this path; the
> QuickSight (Amazon Quick) service footprint in ZHY can differ from commercial regions.

---

## 5. Test the SAML flow

1. IdP-initiated:
   `<KC_URL>/realms/aws-realm/protocol/saml/clients/urn:amazon:webservices` → log in →
   you should land in the **ZHY** AWS console (`console.amazonaws.cn`) as the federated role.
2. *"invalid SAML response"* → check, in order: Role attribute pair is `role,provider`
   and uses `arn:aws-cn`; metadata is current; assertion is signed; `SAML:aud` =
   `https://signin.amazonaws.cn/saml`.

---

## 6. Optional: automate the realm

```bash
kubectl -n keycloak exec -it deploy/keycloak -- \
  /opt/keycloak/bin/kcadm.sh config credentials \
    --server http://localhost:8080 --realm master \
    --user admin --password "$KEYCLOAK_ADMIN_PASSWORD"

kubectl -n keycloak exec -it deploy/keycloak -- \
  /opt/keycloak/bin/kcadm.sh get realms/aws-realm/partial-export -r aws-realm \
  > aws-realm-export.json
```

Re-import with `kcadm.sh create realms -f aws-realm-export.json` (or `keycloak-config-cli`)
to make customer rollouts repeatable.

---

## Summary checklist

- [ ] Realm `aws-realm`, brute-force protection on, test user created.
- [ ] OIDC public client `amazon-quick-desktop` (PKCE S256, loopback/`quick://` redirects).
- [ ] SAML client `urn:amazon:webservices`, ACS `https://signin.amazonaws.cn/saml`.
- [ ] Three SAML mappers: Role (`arn:aws-cn` `role,provider` pair), RoleSessionName, SessionDuration.
- [ ] IAM SAML provider created (`arn:aws-cn:iam::...:saml-provider/...`).
- [ ] Federation role with `sts:AssumeRoleWithSAML` trust (`SAML:aud = signin.amazonaws.cn/saml`) + least-priv policy.
- [ ] Role ARN in Keycloak matches the IAM role ARN.
- [ ] SAML test sign-in into `console.amazonaws.cn` succeeds.
