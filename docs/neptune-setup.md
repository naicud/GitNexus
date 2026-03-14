# AWS Neptune Setup Guide for GitNexus

GitNexus supports AWS Neptune as an alternative graph database backend to the default local KuzuDB. Neptune is ideal for teams who want a managed, scalable graph database in the cloud.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [VPC Configuration](#vpc-configuration)
3. [Security Group](#security-group)
4. [Neptune Subnet Group](#neptune-subnet-group)
5. [Create Neptune Cluster](#create-neptune-cluster)
6. [Create Neptune Instance](#create-neptune-instance)
7. [IAM Policy](#iam-policy)
8. [Configure GitNexus CLI](#configure-gitnexus-cli)
9. [Configure GitNexus Web UI](#configure-gitnexus-web-ui)
10. [AWS Graph Explorer (Optional)](#aws-graph-explorer-optional)
11. [Troubleshooting](#troubleshooting)
12. [Cost Estimation](#cost-estimation)
13. [Limitations (v1)](#limitations-v1)
14. [Cleanup](#cleanup)

---

## Prerequisites

- AWS Account with administrator access
- AWS CLI v2 installed and configured (`aws configure`)
- Node.js 18+ installed
- GitNexus installed (`npm install -g gitnexus`)

Verify AWS CLI is configured:
```bash
aws sts get-caller-identity
```

---

## VPC Configuration

Neptune requires a VPC with at least 2 subnets in different Availability Zones.

### Option A: Use existing VPC

If you already have a VPC with 2+ subnets, note the VPC ID and subnet IDs and skip to [Security Group](#security-group).

### Option B: Create a new VPC

```bash
# Create VPC
aws ec2 create-vpc --cidr-block 10.0.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=gitnexus-neptune-vpc}]'
# Note the VpcId from the output

# Enable DNS support (required for Neptune)
aws ec2 modify-vpc-attribute --vpc-id <VPC_ID> --enable-dns-support
aws ec2 modify-vpc-attribute --vpc-id <VPC_ID> --enable-dns-hostnames

# Get available AZs
aws ec2 describe-availability-zones --query 'AvailabilityZones[].ZoneName' --output text

# Create 2 subnets in different AZs
aws ec2 create-subnet \
  --vpc-id <VPC_ID> \
  --cidr-block 10.0.1.0/24 \
  --availability-zone <AZ_1> \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=gitnexus-neptune-subnet-1}]'

aws ec2 create-subnet \
  --vpc-id <VPC_ID> \
  --cidr-block 10.0.2.0/24 \
  --availability-zone <AZ_2> \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=gitnexus-neptune-subnet-2}]'

# Create Internet Gateway (if you need external access)
aws ec2 create-internet-gateway --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=gitnexus-neptune-igw}]'
aws ec2 attach-internet-gateway --internet-gateway-id <IGW_ID> --vpc-id <VPC_ID>

# Create route table and add default route
aws ec2 create-route-table --vpc-id <VPC_ID>
aws ec2 create-route --route-table-id <RTB_ID> --destination-cidr-block 0.0.0.0/0 --gateway-id <IGW_ID>
aws ec2 associate-route-table --route-table-id <RTB_ID> --subnet-id <SUBNET_1_ID>
aws ec2 associate-route-table --route-table-id <RTB_ID> --subnet-id <SUBNET_2_ID>
```

---

## Security Group

Create a security group that allows access to Neptune's port (8182):

```bash
aws ec2 create-security-group \
  --group-name gitnexus-neptune-sg \
  --description "GitNexus Neptune access" \
  --vpc-id <VPC_ID>
# Note the GroupId

# Allow Neptune port from your IP (for local development)
MY_IP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress \
  --group-id <SG_ID> \
  --protocol tcp \
  --port 8182 \
  --cidr ${MY_IP}/32

# Allow Neptune port from within VPC (for EC2/Lambda access)
aws ec2 authorize-security-group-ingress \
  --group-id <SG_ID> \
  --protocol tcp \
  --port 8182 \
  --cidr 10.0.0.0/16
```

> **Note:** For production, restrict access to specific IPs or security groups only.

---

## Neptune Subnet Group

```bash
aws neptune create-db-subnet-group \
  --db-subnet-group-name gitnexus-neptune-subnets \
  --db-subnet-group-description "Subnets for GitNexus Neptune cluster" \
  --subnet-ids <SUBNET_1_ID> <SUBNET_2_ID>
```

---

## Create Neptune Cluster

```bash
aws neptune create-db-cluster \
  --db-cluster-identifier gitnexus-graph \
  --engine neptune \
  --engine-version 1.3.4.0 \
  --vpc-security-group-ids <SG_ID> \
  --db-subnet-group-name gitnexus-neptune-subnets \
  --iam-database-authentication-enabled \
  --storage-encrypted
```

---

## Create Neptune Instance

```bash
# For development/small codebases:
aws neptune create-db-instance \
  --db-instance-identifier gitnexus-graph-1 \
  --db-instance-class db.t3.medium \
  --engine neptune \
  --db-cluster-identifier gitnexus-graph

# For production/large codebases (10k+ files):
# Use db.r5.large or db.r5.xlarge instead
```

Wait for the instance to become available:

```bash
aws neptune wait db-instance-available --db-instance-identifier gitnexus-graph-1
```

Get the cluster endpoint:

```bash
NEPTUNE_ENDPOINT=$(aws neptune describe-db-clusters \
  --db-cluster-identifier gitnexus-graph \
  --query 'DBClusters[0].Endpoint' \
  --output text)
echo "Neptune endpoint: ${NEPTUNE_ENDPOINT}"
```

---

## IAM Policy

Create an IAM policy for Neptune access:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "neptune-db:ReadDataViaQuery",
        "neptune-db:WriteDataViaQuery",
        "neptune-db:DeleteDataViaQuery",
        "neptune-db:GetQueryStatus",
        "neptune-db:CancelQuery"
      ],
      "Resource": "arn:aws:neptune-db:<REGION>:<ACCOUNT_ID>:*/*"
    }
  ]
}
```

```bash
# Save the policy to a file
cat > neptune-policy.json << 'POLICY'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["neptune-db:*"],
    "Resource": "arn:aws:neptune-db:*:*:*/*"
  }]
}
POLICY

aws iam create-policy \
  --policy-name GitNexusNeptuneAccess \
  --policy-document file://neptune-policy.json

# Attach to your IAM user or role
aws iam attach-user-policy \
  --user-name <YOUR_USER> \
  --policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/GitNexusNeptuneAccess
```

---

## Configure GitNexus CLI

### Environment Variables (recommended)

```bash
export GITNEXUS_DB_TYPE=neptune
export GITNEXUS_NEPTUNE_ENDPOINT=<NEPTUNE_ENDPOINT>
export GITNEXUS_NEPTUNE_REGION=<AWS_REGION>
# Optional: export GITNEXUS_NEPTUNE_PORT=8182
```

### CLI Flags

```bash
gitnexus analyze --db neptune \
  --neptune-endpoint <NEPTUNE_ENDPOINT> \
  --neptune-region <AWS_REGION> \
  /path/to/your/repo
```

### Querying

After indexing, all GitNexus CLI commands work transparently:

```bash
gitnexus query "authentication flow"
gitnexus context validateUser
gitnexus impact --target handleRequest
gitnexus cypher "MATCH (n:Function) RETURN n.name LIMIT 10"
```

The CLI and MCP server automatically detect the Neptune backend from the registry.

---

## Configure GitNexus Web UI

1. Start the GitNexus server: `gitnexus serve`
2. Open `http://localhost:4747` in your browser
3. Click **Settings** (gear icon)
4. Scroll to **Database Backend**
5. Select **Neptune (AWS)**
6. Enter:
   - **Neptune Endpoint**: your cluster endpoint (e.g., `gitnexus-graph.cluster-xxxxx.us-east-1.neptune.amazonaws.com`)
   - **AWS Region**: e.g., `us-east-1`
   - **Port**: `8182` (default)
7. Click **Test Connection** to verify
8. Click **Save**

---

## AWS Graph Explorer (Optional)

[AWS Graph Explorer](https://github.com/aws/graph-explorer) is an open-source visual tool for exploring graph databases. Deploy it alongside Neptune for a visual exploration experience.

### Docker Deployment

```bash
docker run -p 443:443 \
  -e GRAPH_CONNECTION_URL=https://<NEPTUNE_ENDPOINT>:8182 \
  -e USING_PROXY_SERVER=true \
  -e IAM=true \
  -e AWS_REGION=<AWS_REGION> \
  -e GRAPH_TYPE=gremlin \
  -e PROXY_SERVER_HTTPS_CONNECTION=true \
  -e SERVICE_TYPE=neptune-db \
  public.ecr.aws/neptune/graph-explorer:latest
```

Then open `https://localhost` to access Graph Explorer.

> **Note:** Graph Explorer must have network access to Neptune (same VPC or VPN).

---

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| Connection refused | Security group blocks port 8182 | Add your IP to the security group ingress rules |
| Connection timeout | Not in same VPC | Use a VPN, bastion host, or SSH tunnel to reach Neptune |
| Authentication error | Invalid/missing AWS credentials | Run `aws sts get-caller-identity` and verify IAM policy |
| SSL/TLS error | Neptune requires HTTPS | Ensure you're not using HTTP -- the SDK handles this automatically |
| `CONTAINS` slow on large graphs | No FTS indexes on Neptune | This is a v1 limitation -- search uses text predicates |
| Embeddings skipped | Not supported on Neptune v1 | Semantic search is unavailable; keyword search still works |

### SSH Tunnel (for local development)

If Neptune is in a private VPC, use an SSH tunnel through a bastion host:

```bash
ssh -N -L 8182:<NEPTUNE_ENDPOINT>:8182 ec2-user@<BASTION_IP>
```

Then use `localhost` as the endpoint:

```bash
gitnexus analyze --db neptune --neptune-endpoint localhost --neptune-region <REGION>
```

---

## Cost Estimation

| Instance Type | vCPUs | RAM | Hourly Cost | Monthly Estimate |
|--------------|-------|-----|-------------|-----------------|
| db.t3.medium | 2 | 4 GB | ~$0.094 | ~$68 |
| db.r5.large | 2 | 16 GB | ~$0.348 | ~$250 |
| db.r5.xlarge | 4 | 32 GB | ~$0.696 | ~$500 |

**Additional costs:**
- Storage: $0.10/GB/month
- I/O requests: $0.20 per 1 million requests
- Data transfer: standard AWS data transfer rates

> **Tip:** For development, use `db.t3.medium`. For production with large codebases (10k+ files), use `db.r5.large` or larger.

---

## Limitations (v1)

| Feature | KuzuDB (Local) | Neptune (AWS) |
|---------|---------------|---------------|
| Full-text search (FTS) | BM25 indexes | CONTAINS predicate (slower) |
| Semantic embeddings | transformers.js | Not supported |
| Hybrid search | BM25 + semantic | Text predicates only |
| Storage | Local filesystem | AWS managed |
| Cost | Free | AWS pricing |
| Multi-repo per DB | Yes | One cluster per repo (v1) |
| Connection | File-based (fast) | HTTP/HTTPS (network latency) |

---

## Cleanup

To delete Neptune resources when no longer needed:

```bash
# Delete instance
aws neptune delete-db-instance \
  --db-instance-identifier gitnexus-graph-1 \
  --skip-final-snapshot

# Wait for deletion
aws neptune wait db-instance-deleted --db-instance-identifier gitnexus-graph-1

# Delete cluster
aws neptune delete-db-cluster \
  --db-cluster-identifier gitnexus-graph \
  --skip-final-snapshot

# Delete subnet group
aws neptune delete-db-subnet-group --db-subnet-group-name gitnexus-neptune-subnets

# Delete security group
aws ec2 delete-security-group --group-id <SG_ID>
```
