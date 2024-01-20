import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as iam from "aws-cdk-lib/aws-iam";

export class EC2CustodyStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create VPC
    const vpc = new ec2.Vpc(this, "MyVpc", {
      maxAzs: 2, // Adjust based on your requirement
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // ------------- SECURITY GROUP SECTION  -----------------
    // public SG for bastion
    const publicSG = new ec2.SecurityGroup(this, "publicSG", {
      vpc,
      description: "Allow SSH (TCP port 22) in",
      allowAllOutbound: true,
      securityGroupName: "SG-CUSTODY-Bastion",
    });
    // allow any IP . to ssh to bastion
    publicSG.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      "Allow SSH Access"
    );
    // private SG for server
    const privateSG = new ec2.SecurityGroup(this, "privateSG", {
      vpc,
      description: "Allow BASTION",
      allowAllOutbound: true,
      securityGroupName: "SG-CUSTODY-Private",
    });
    // allow only bastion to ssh to this ec2
    privateSG.addIngressRule(
      publicSG,
      ec2.Port.tcp(22),
      "Allow SSH From public SG"
    );
    // privateSG.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3000), "Allow curl from public SG");

    //-------------ROLES ---- for pulling image from ECR
    const role = new iam.Role(this, "ec2Role", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    });
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonEC2ContainerRegistryReadOnly"
      )
    );

    // const keyName = "aegis";
    const keyPair = ec2.KeyPair.fromKeyPairName(this, "KeyPair", "aegis");

    // Create Bastion Host in Public Subnet
    const bastionHost = new ec2.Instance(this, "BastionHost", {
      vpc,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.NANO
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      keyPair,
      securityGroup: publicSG,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // Create Private EC2 Instance in Private Subnet
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      ...installDocker,
      ...installDockerCompose,
      ...installAwsCli
    );

    const machineImage = ec2.MachineImage.fromSsmParameter(
      "/aws/service/canonical/ubuntu/server/focal/stable/current/amd64/hvm/ebs-gp2/ami-id",
      {
        os: ec2.OperatingSystemType.LINUX,
        userData,
      }
    );

    const privateInstance = new ec2.Instance(this, "PrivateInstance", {
      vpc,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      keyPair,

      // machineImage: ec2.MachineImage.latestAmazonLinux2023({ userData }),
      machineImage, // ubuntu
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroup: privateSG,
      role,
    });

    // Create Elastic Load Balancer
    const loadBalancer = new elbv2.ApplicationLoadBalancer(
      this,
      "MyLoadBalancer",
      {
        vpc,
        internetFacing: true, // Public Load Balancer
      }
    );

    // Create Target Group
    const targetGroup = new elbv2.ApplicationTargetGroup(
      this,
      "MyTargetGroup",
      {
        vpc,
        protocol: elbv2.ApplicationProtocol.HTTP,
        port: 3000,
        targets: [new targets.InstanceTarget(privateInstance)],
      }
    );

    const cert = new acm.Certificate(this, "custody-stag-cert", {
      domainName: "*.sens-vn.com",
      validation: acm.CertificateValidation.fromDns(),
    });

    // Create Listener
    const listener = loadBalancer.addListener("Listener", {
      port: 443,
      open: true,
      defaultTargetGroups: [targetGroup],
      certificates: [cert],
    });
    loadBalancer.addRedirect({
      sourcePort: 80,
      sourceProtocol: elbv2.ApplicationProtocol.HTTP,
      targetPort: 443,
      targetProtocol: elbv2.ApplicationProtocol.HTTPS,
    });

    // Output Bastion Host Public DNS
    new cdk.CfnOutput(this, "BastionHostPublicDns", {
      value: bastionHost.instancePublicIp,
      description: "Bastion Host Public DNS",
    });

    // Output Load Balancer DNS
    new cdk.CfnOutput(this, "LoadBalancerDns", {
      value: loadBalancer.loadBalancerDnsName,
      description: "Load Balancer DNS",
    });
    // ------------- OUTPUT SECTION  -----------------
    // Create outputs for connecting
    // new cdk.CfnOutput(this, "Bastion IP Address", { value: bastion.instancePublicIp });
    new cdk.CfnOutput(this, "Server  Private IP Address", {
      value: privateInstance.instancePrivateIp,
    });
    new cdk.CfnOutput(this, "Bastion Private IP ", {
      value: bastionHost.instancePrivateIp,
    });
    new cdk.CfnOutput(this, "Bastion IP ", {
      value: bastionHost.instancePublicIp,
    });
    new cdk.CfnOutput(this, "ssh command", {
      // value: "ssh -i cdk-key.pem -o IdentitiesOnly=yes ubuntu@" + bastion.instancePublicIp,
      value: `chmod 400 custody.pem && ssh -o ProxyCommand="ssh -i ./custody.pem -W %h:%p ec2-user@${bastionHost.instancePublicIp}" -i ./custody.pem ubuntu@${privateInstance.instancePrivateIp}`,
    });
  }
}
// const app = new cdk.App();
// new EC2custodyStack(app, "EC2custodyStack");

export const installDocker = [
  "sudo apt install nodejs npm -y",
  "sudo apt update -y",
  "sudo apt install -y docker.io",
  "sudo systemctl start docker",
  "sudo systemctl enable docker",
  "sudo usermod -aG docker $USER",
];

export const installDockerCompose = [
  `curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose`,
  `chmod +x /usr/local/bin/docker-compose`,
];

export const installAwsCli = [
  "sudo apt update -y",
  "sudo apt install -y awscli",
  "sudo apt install -y python3-pip",
  "sudo pip3 install awscli --upgrade",
];

export const installHSM = [
  "sudo apt update",
  "sudo apt install -y automake autoconf libtool git build-essential pkg-config libssl-dev sqlite3 python3",
  "wget https://botan.randombit.net/releases/old/Botan-1.10.0.tgz",
  "tar -xvf Botan-1.10.0.tgz",
  "cd Botan-1.10.0/",
  "./configure.py --with-gnump",
  "make",
  "make install",
  "cd ..",
  "rm -rf Botan-1.10.0/ Botan-1.10.0.tgz",
  "sudo apt-get update && sudo apt-get install softhsm2 -y",
  "export SOFTHSM2_CONF=/etc/softhsm/softhsm2.conf",
  'softhsm2-util --init-token --slot 0 --label "MyToken" --pin "khiemne" --so-pin 5678',
  'echo "SoftHSM installation completed!"',
  'echo "SoftHSM configuration location set to: /etc/softhsm2.conf"',
  "echo \"Token 'MyToken' initialized in slot 0 with User PIN: khiemne and SO PIN: 5678\"",
];
