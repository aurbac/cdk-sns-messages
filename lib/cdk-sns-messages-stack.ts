import * as cdk from '@aws-cdk/core';
import * as ecr from '@aws-cdk/aws-ecr';
import * as ec2 from '@aws-cdk/aws-ec2';

import * as ecs from '@aws-cdk/aws-ecs';
import * as iam from '@aws-cdk/aws-iam';

import * as ecs_patterns from '@aws-cdk/aws-ecs-patterns';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';

import * as cache from '@aws-cdk/aws-elasticache';

import * as lambda from '@aws-cdk/aws-lambda';
import * as lambda_python from '@aws-cdk/aws-lambda-python';
import * as sqs from '@aws-cdk/aws-sqs';
import { SqsEventSource, SqsDlq } from '@aws-cdk/aws-lambda-event-sources';

export class CdkSnsMessagesStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here
    
    const current_path = process.cwd();
    
    const repository = new ecr.Repository(this, "backend-app", {
      repositoryName: "backend-app"
    });
    
    const vpc = new ec2.Vpc(this, "my-vpc", {
      cidr: "10.1.0.0/16",
      natGateways: 1,
      subnetConfiguration: [
        {  cidrMask: 24, subnetType: ec2.SubnetType.PUBLIC, name: "Public" },
        {  cidrMask: 24, subnetType: ec2.SubnetType.PRIVATE, name: "Private" }
        ],
      maxAzs: 3 // Default is all AZs in region
    });
    
    
    const redisSubnetGroup = new cache.CfnSubnetGroup(
      this,
      "RedisClusterPrivateSubnetGroup",
      {
        cacheSubnetGroupName: "private",
        subnetIds: vpc.privateSubnets.map(function(subnet) {
            return subnet.subnetId;
          }),
        description: "private subnets"
      }
    );
    

    // The security group that defines network level access to the cluster
    const securityGroup = new ec2.SecurityGroup(this, `redis-security-group`, { vpc: vpc });
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(6379), 'allow redis access from the world');


    // The cluster resource itself.
    const redisCluster = new cache.CfnCacheCluster(this, `redis-cluster`, {
      cacheNodeType: 'cache.m5.large',
      engine: 'redis',
      numCacheNodes: 1,
      autoMinorVersionUpgrade: true,
      cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName,
      vpcSecurityGroupIds: [
        securityGroup.securityGroupId
      ]
    });
    
    /*
    const redisReplication = new cache.CfnReplicationGroup(
      this,
      `RedisReplicaGroup`,
      {
        engine: "redis",
        cacheNodeType: "cache.m5.xlarge",
        replicasPerNodeGroup: 1,
        numNodeGroups: 2,
        automaticFailoverEnabled: true,
        autoMinorVersionUpgrade: true,
        replicationGroupDescription: "cluster redis",
        cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName,
        securityGroupIds: [
          securityGroup.securityGroupId
        ]
      }
    );
    redisReplication.addDependsOn(redisSubnetGroup);
    */
    
    const cluster = new ecs.Cluster(this, "cluster", {
      vpc: vpc
    });
    
    
    const executionRolePolicy =  new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
                "ecr:GetAuthorizationToken",
                "ecr:BatchCheckLayerAvailability",
                "ecr:GetDownloadUrlForLayer",
                "ecr:BatchGetImage",
                "logs:CreateLogStream",
                "logs:PutLogEvents"
            ]
    });

    const fargateTaskDefinition = new ecs.FargateTaskDefinition(this, 'task-backend-app', {
      memoryLimitMiB: 512,
      cpu: 256,
    });
    fargateTaskDefinition.addToExecutionRolePolicy(executionRolePolicy);
    fargateTaskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: ['sns:*']
    }));

    const container = fargateTaskDefinition.addContainer("container-backend-app", {
      image: ecs.ContainerImage.fromRegistry(repository.repositoryUri),
      environment: { 
        'REDIS_ENDPOINT_ADDRESS' : redisCluster.attrRedisEndpointAddress,
        'REDIS_ENDPOINT_PORT' : redisCluster.attrRedisEndpointPort
      }
    });

    container.addPortMappings({
      containerPort: 5000
    });
    
    const sg_service = new ec2.SecurityGroup(this, 'sg-backend-app', { vpc: vpc });
    sg_service.addIngressRule(ec2.Peer.ipv4('0.0.0.0/0'), ec2.Port.tcp(5000));

    const service = new ecs.FargateService(this, 'service-backenda-app', {
      cluster,
      taskDefinition: fargateTaskDefinition,
      desiredCount: 2,
      assignPublicIp: false,
      securityGroup: sg_service
    });

    // Setup AutoScaling policy
    const scaling = service.autoScaleTaskCount({ maxCapacity: 6, minCapacity: 2 });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 50,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60)
    });
    
    
    const lb = new elbv2.ApplicationLoadBalancer(this, 'alb', {
      vpc,
      internetFacing: true
    });

    const listener = lb.addListener('Listener', {
      port: 80,
    });

    listener.addTargets('Target', {
      port: 80,
      targets: [service],
      healthCheck: { path: '/' }
    });
    
    listener.connections.allowDefaultPortFromAnyIpv4('Open to the world');
    
    
    const deadLetterQueue = new sqs.Queue(this, 'deadLetterQueue', {
      deliveryDelay: cdk.Duration.millis(0),
      retentionPeriod: cdk.Duration.days(14),
    });
    
    const queue = new sqs.Queue(this, 'MyQueue', {
      deliveryDelay: cdk.Duration.millis(0),
      visibilityTimeout: cdk.Duration.seconds(30),
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: deadLetterQueue
      }
    });
    
    /*
    const sendMessagesFunction = new lambda.Function(this, 'SendMessages', {
      runtime: lambda.Runtime.PYTHON_3_6,
      code: lambda.Code.fromAsset('lambda'),
      handler: 'app.handler',
      memorySize: 1024,
      reservedConcurrentExecutions: 50,
      timeout: cdk.Duration.seconds(10),
      environment: {
        'REDIS_ENDPOINT_ADDRESS' : redisCluster.attrRedisEndpointAddress,
        'REDIS_ENDPOINT_PORT' : redisCluster.attrRedisEndpointPort
      }
    });
    */
    
    const sendMessagesFunction = new lambda_python.PythonFunction(this, 'SendMessages', {
      entry: current_path+'/lambda/', // required
      index: 'app.py', // optional, defaults to 'index.py'
      handler: 'handler', // optional, defaults to 'handler'
      runtime: lambda.Runtime.PYTHON_3_6,
      memorySize: 1024,
      reservedConcurrentExecutions: 50,
      timeout: cdk.Duration.seconds(10),
      environment: {
        'REDIS_ENDPOINT_ADDRESS' : redisCluster.attrRedisEndpointAddress,
        'REDIS_ENDPOINT_PORT' : redisCluster.attrRedisEndpointPort
      }
    });
    
    sendMessagesFunction.addEventSource(new SqsEventSource(queue, { 
      batchSize: 10
    }));
    
    sendMessagesFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: ['sns:*']
    }));
    
    
  }
}
