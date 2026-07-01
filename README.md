# Keycloak 高可用 IdP on AWS（CDK）

生产级、高可用的 Keycloak 身份提供商（IdP），用 AWS CDK（TypeScript）部署，全栈 ARM/Graviton。用于 Amazon Quick / QuickSight 单点登录（SSO）。

本仓库包含**两个独立的区域版本**，请按目标区域进入对应目录部署（各自独立的 `node_modules` / `cdk.out`，互不混用）：

| 目录 | 区域 | 公网入口 | 说明 |
|------|------|----------|------|
| [`us-west-2/`](./us-west-2/) | 美西（俄勒冈）`us-west-2` | **CloudFront + ALB** | CloudFront 提供默认 HTTPS |
| [`ZHY/`](./ZHY/) | ZHY宁夏 `cn-northwest-1` | **ALB**（无 CloudFront） | 需 ICP 备案 |

## 架构

两个版本共享同一套后端架构，仅公网入口不同：

```
us-west-2:  用户 → CloudFront → ALB → EKS(Keycloak, Graviton) → Aurora PostgreSQL(Graviton)
ZHY (ZHY): 用户 → ALB → EKS(Keycloak, Graviton) → Aurora PostgreSQL(Graviton)
```

共同要点：
- EKS 跑在 Graviton（ARM）托管节点组，Keycloak 多副本 + 反亲和 + HPA + PDB，JDBC_PING 集群
- Aurora PostgreSQL（Graviton）写+读实例、多 AZ、加密、强制 TLS、位于隔离子网
- 凭据由 Secrets Manager 生成，经 Secrets Store CSI Driver（IRSA）注入，无明文密钥
- ALB 安全组收敛（us-west-2 锁定到 CloudFront 前缀列表；ZHY 限制到 `allowedCidrs`）

## 文档（中英文均提供）

每个版本都同时提供**中文**和**英文**文档：

### us-west-2（商业区）
| 文档 | 中文 | English |
|------|------|---------|
| 部署手册 | [部署手册.md](./us-west-2/部署手册.md) | [README.md](./us-west-2/README.md) |
| SSO 联合配置 | [使用指南.md](./us-west-2/使用指南.md) | [USAGE-GUIDE.md](./us-west-2/USAGE-GUIDE.md) |

### ZHY（ZHY宁夏 cn-northwest-1）
| 文档 | 中文 | English |
|------|------|---------|
| 部署手册 | [部署手册.md](./ZHY/部署手册.md) | [README.md](./ZHY/README.md) |
| SSO 联合配置 | [使用指南.md](./ZHY/使用指南.md) | [USAGE-GUIDE.md](./ZHY/USAGE-GUIDE.md) |

## 快速开始

```bash
cd us-west-2   # 或 cd ZHY
# 1) 编辑 lib/config.ts（必填 eks.clusterAdminPrincipalArns 等，详见对应部署手册）
npm install
npm run build
npx cdk bootstrap aws://<账号ID>/<区域>
npx cdk deploy --all
```

> 部署前的完整检查清单、两阶段固定 KC_HOSTNAME、特定适配（ECR 镜像、ICP 备案等）请阅读对应目录的**部署手册**。

## 安全说明

- 凭据通过 Secrets Manager + CSI 注入，仓库内无任何明文密钥/账号信息（`config.ts` 为空模板）。
- 三层 `.gitignore` 拦截 `node_modules`、`cdk.out`、`*.local.txt`、`.env`、`cdk.context.json` 等。
- 生产环境建议：限制 EKS 公网 API 端点来源、为入口关联 AWS WAF、收紧 IAM 最小权限。

## 主要技术栈

AWS CDK · TypeScript · Amazon EKS · AWS Load Balancer Controller · Aurora PostgreSQL · Secrets Store CSI Driver · CloudFront · ALB · Keycloak 26.x · Graviton
