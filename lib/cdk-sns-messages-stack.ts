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
import * as dynamodb from '@aws-cdk/aws-dynamodb';

export class CdkSnsMessagesStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    
    //////////////////////////////////////////////////////////////////////
    // STEP 1
    //////////////////////////////////////////////////////////////////////
    
    // Amazon ECS Repository to store image container
    
    const repository = new ecr.Repository(this, "backend-app", {
      repositoryName: "backend-app"
    });
    
    
    //////////////////////////////////////////////////////////////////////
    // STEP 4
    //////////////////////////////////////////////////////////////////////
    
    // DynamoDB Tables
    
    const topics = new dynamodb.Table(this, 'topics', {
      partitionKey: {
        name: 'topic_arn',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });
    new cdk.CfnOutput(this, 'TopicsTableName', { value: topics.tableName });
    
    const subscriptions = new dynamodb.Table(this, 'subscriptions', {
      partitionKey: {
        name: 'subscription_arn',
        type: dynamodb.AttributeType.STRING
      }, 
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });
    subscriptions.addGlobalSecondaryIndex({
      indexName: 'subscription', 
      projectionType: dynamodb.ProjectionType.ALL,
      partitionKey: {
        name: 'endpoint',
        type: dynamodb.AttributeType.STRING
      }, sortKey: {
        name: 'topic_name',
        type: dynamodb.AttributeType.STRING
      }
    });
    new cdk.CfnOutput(this, 'SubscriptionsTableName', { value: subscriptions.tableName });
    
    // Network configuration
    
    const vpc = new ec2.Vpc(this, "my-vpc", {
      cidr: "10.1.0.0/16",
      natGateways: 1,
      subnetConfiguration: [
        {  cidrMask: 24, subnetType: ec2.SubnetType.PUBLIC, name: "Public" },
        {  cidrMask: 24, subnetType: ec2.SubnetType.PRIVATE, name: "Private" }
        ],
      maxAzs: 3 // Default is all AZs in region
    });
    
    // Cluster with Amazon ElastiCache
    /*
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

    // The redis cluster
    
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
    */
    
    // Amazon ECS cluster
    
    const cluster = new ecs.Cluster(this, "cluster", {
      vpc: vpc
    });
    
    // IAM Role policy for Amazon ECS
    
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

    // Amazon ECS container service definition
    
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
    fargateTaskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: [topics.tableArn, subscriptions.tableArn],
      actions: ['dynamodb:*']
    }));

    const container = fargateTaskDefinition.addContainer("container-backend-app", {
      image: ecs.ContainerImage.fromRegistry(repository.repositoryUri),
      environment: { 
        //REDIS_ENDPOINT_ADDRESS : redisCluster.attrRedisEndpointAddress,
        //REDIS_ENDPOINT_PORT : redisCluster.attrRedisEndpointPort,
        TOPICS_TABLE_NAME : topics.tableName,
        SUBSCRIPTIONS_TABLE_NAME : subscriptions.tableName
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
    
    // Application Load Balancer for Amazon ECS services
    
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
    
    new cdk.CfnOutput(this, 'LoadBalancerDnsName', { value: lb.loadBalancerDnsName });
    
    // Amazon SQS - Queue service
    
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
    
    // Lambda function
    
    const current_path = process.cwd();
    
    const sendMessagesFunction = new lambda_python.PythonFunction(this, 'SendMessages', {
      entry: current_path+'/lambda/', 
      index: 'app.py', 
      handler: 'handler',
      runtime: lambda.Runtime.PYTHON_3_6,
      memorySize: 1024,
      reservedConcurrentExecutions: 50,
      timeout: cdk.Duration.seconds(10),
      environment: {
        //REDIS_ENDPOINT_ADDRESS : redisCluster.attrRedisEndpointAddress,
        //REDIS_ENDPOINT_PORT : redisCluster.attrRedisEndpointPort,
        TOPICS_TABLE_NAME : topics.tableName,
        SUBSCRIPTIONS_TABLE_NAME : subscriptions.tableName
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
    sendMessagesFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: [topics.tableArn, subscriptions.tableArn],
      actions: ['dynamodb:*']
    }));
    
  }
}
