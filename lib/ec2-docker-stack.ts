import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export class EC2DockerStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a VPC
    const vpc = new ec2.Vpc(this, 'MyVpc', {
      maxAzs: 2, // You can customize this based on your needs
    });

    // Create an EC2 instance
    const instance = new ec2.Instance(this, 'MyEC2Instance', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux({ generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2 }),
    });

    // (Optional) Add user data to install Docker or any other software on instance launch
    instance.userData.addCommands(
      'sudo yum update -y',
      'sudo amazon-linux-extras install docker -y',
      'sudo service docker start',
      'sudo usermod -aG docker ec2-user', // Add the user to the docker group (optional)
    );

    // (Optional) Allow incoming traffic on port 80 for web services
    instance.connections.allowFromAnyIpv4(ec2.Port.tcp(80), 'Allow HTTP access');
  }
}
