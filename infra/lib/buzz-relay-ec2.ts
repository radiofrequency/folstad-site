import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";
import * as path from "node:path";

export interface BuzzRelayEc2Props {
  vpc: ec2.IVpc;
  /** Public hostname clients join, e.g. relay.buzzftw.com */
  domain: string;
  zoneId: string;
  zoneName: string;
  instanceType?: string;
  acmeEmail?: string;
  /** When true, upsert A records (cutover). Default false so deploy is safe. */
  cutoverDns?: boolean;
}

/**
 * Single Graviton EC2 running upstream Buzz compose (relay + postgres + redis + minio).
 * No LNbits / Lightning. Caddy is enabled after DNS cutover (see scripts).
 */
export class BuzzRelayEc2 extends Construct {
  readonly instance: ec2.Instance;
  readonly eip: ec2.CfnEIP;
  readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: BuzzRelayEc2Props) {
    super(scope, id);

    const instanceTypeName = props.instanceType ?? "t4g.medium";
    const acmeEmail = props.acmeEmail ?? `ops@${props.zoneName}`;

    const bundle = new s3assets.Asset(this, "RelayBundle", {
      path: path.join(__dirname, "../../packages/buzz-platform/deploy"),
    });

    this.securityGroup = new ec2.SecurityGroup(this, "RelaySg", {
      vpc: props.vpc,
      description: "Buzz free relay: HTTP/HTTPS only",
      allowAllOutbound: true,
    });
    this.securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "HTTP / ACME");
    this.securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS");

    const role = new iam.Role(this, "RelayRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });
    bundle.grantRead(role);
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret",
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:TagResource",
        ],
        resources: [
          `arn:aws:secretsmanager:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:secret:buzz/*`,
        ],
      }),
    );

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -euxo pipefail",
      "dnf install -y docker awscli unzip jq python3 openssl",
      "systemctl enable --now docker",
      "mkdir -p /usr/libexec/docker/cli-plugins",
      "curl -fsSL -o /usr/libexec/docker/cli-plugins/docker-compose https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-aarch64",
      "chmod +x /usr/libexec/docker/cli-plugins/docker-compose",
      `export AWS_REGION=${cdk.Stack.of(this).region}`,
      `export AWS_DEFAULT_REGION=${cdk.Stack.of(this).region}`,
      `export BUZZ_DOMAIN=${props.domain}`,
      `export BUZZ_WILDCARD_BASE=${props.zoneName}`,
      `export CADDY_ACME_EMAIL=${acmeEmail}`,
      "export BUZZ_COMPOSE_TLS=false",
    );
    userData.addS3DownloadCommand({
      bucket: bundle.bucket,
      bucketKey: bundle.s3ObjectKey,
      localFile: "/tmp/buzz-relay-bundle.zip",
    });
    userData.addCommands(
      "mkdir -p /opt/buzz",
      "unzip -o /tmp/buzz-relay-bundle.zip -d /opt/buzz",
      "chmod +x /opt/buzz/*.sh /opt/buzz/*.py || true",
      "cat >/etc/systemd/system/buzz-relay.service <<'UNIT'",
      "[Unit]",
      "Description=Buzz free relay (docker compose)",
      "After=docker.service",
      "Requires=docker.service",
      "[Service]",
      "Type=oneshot",
      "RemainAfterExit=yes",
      "WorkingDirectory=/opt/buzz",
      "Environment=BUZZ_COMPOSE_TLS=false",
      "ExecStart=/opt/buzz/run.sh start",
      "ExecStop=/opt/buzz/run.sh stop",
      "[Install]",
      "WantedBy=multi-user.target",
      "UNIT",
      "systemctl daemon-reload",
      "systemctl enable buzz-relay.service",
      "/opt/buzz/bootstrap.sh",
    );

    this.instance = new ec2.Instance(this, "Relay", {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(instanceTypeName),
      machineImage: ec2.MachineImage.fromSsmParameter(
        "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64",
        { os: ec2.OperatingSystemType.LINUX, cachedInContext: false },
      ),
      securityGroup: this.securityGroup,
      role,
      userData,
      associatePublicIpAddress: true,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(40, {
            encrypted: true,
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
      requireImdsv2: true,
    });
    cdk.Tags.of(this.instance).add("Name", "buzz-relay");

    const cfn = this.instance.node.defaultChild as ec2.CfnInstance;
    cfn.creditSpecification = { cpuCredits: "standard" };
    cfn.disableApiTermination = true;
    cfn.metadataOptions = {
      httpEndpoint: "enabled",
      httpTokens: "required",
      httpPutResponseHopLimit: 2,
    };

    this.eip = new ec2.CfnEIP(this, "Eip", { domain: "vpc" });
    new ec2.CfnEIPAssociation(this, "EipAssoc", {
      allocationId: this.eip.attrAllocationId,
      instanceId: this.instance.instanceId,
    });

    if (props.cutoverDns) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "BuzzFtwZone", {
        hostedZoneId: props.zoneId,
        zoneName: props.zoneName,
      });
      new route53.ARecord(this, "RelayA", {
        zone,
        recordName: props.domain.replace(new RegExp(`\\.${props.zoneName}$`), ""),
        target: route53.RecordTarget.fromIpAddresses(this.eip.ref),
        ttl: cdk.Duration.minutes(1),
      });
      new route53.ARecord(this, "WildcardA", {
        zone,
        recordName: "*",
        target: route53.RecordTarget.fromIpAddresses(this.eip.ref),
        ttl: cdk.Duration.minutes(1),
      });
    }
  }
}
