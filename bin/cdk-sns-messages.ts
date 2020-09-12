#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { CdkSnsMessagesStack } from '../lib/cdk-sns-messages-stack';

const app = new cdk.App();
new CdkSnsMessagesStack(app, 'CdkSnsMessagesStack');
