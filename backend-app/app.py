import boto3
import botocore
import os
from flask import Flask, abort, request, jsonify
app = Flask(__name__)


TOPICS_TABLE_NAME = os.environ["TOPICS_TABLE_NAME"]
SUBSCRIPTIONS_TABLE_NAME = os.environ["SUBSCRIPTIONS_TABLE_NAME"]

@app.route('/')
def index():
    return 'Ok'


@app.route('/create-topic', methods=['POST'])
def create_topic():
    data = request.json
    if 'topic_name' in data:
        try:
            sns = boto3.client('sns')
            response = sns.create_topic(
                Name=data['topic_name']
            )
            if 'TopicArn' in response:
                dynamodb = boto3.client('dynamodb')
                dynamodb.update_item(
                    TableName = TOPICS_TABLE_NAME,
                    Key = {
                        'topic_arn' : { 'S': response['TopicArn'] }
                    }
                )
        except botocore.exceptions.ClientError as error:
            abort(500, description=error)
        return jsonify(response)
    else:
        abort(500, description="Error creating topic")
     
        
@app.route('/delete-topic', methods=['POST'])
def delete_topic():
    data = request.json
    if 'topic_name' in data:
        try:
            sns = boto3.client('sns')
            account_id = boto3.client('sts').get_caller_identity().get('Account')
            region = sns.meta.region_name
            topic_arn = 'arn:aws:sns:'+region+':'+account_id+':'+data['topic_name']
            response = sns.delete_topic(
                TopicArn=topic_arn
            )
            if response['ResponseMetadata']['HTTPStatusCode']==200:
                dynamodb = boto3.client('dynamodb')
                dynamodb.delete_item(
                    TableName = TOPICS_TABLE_NAME,
                    Key = {
                        'topic_arn' : { 'S': topic_arn }
                    }
                )
        except botocore.exceptions.ClientError as error:
            abort(500, description=error)
        return jsonify(response)
    else:
        abort(500, description="Error deleting topic")
     
        
@app.route('/subscribe', methods=['POST'])
def subscribe():
    data = request.json
    if 'topic_name' in data and 'protocol' in data and 'endpoint' in data:
        try:
            sns = boto3.client('sns')
            account_id = boto3.client('sts').get_caller_identity().get('Account')
            region = sns.meta.region_name
            topic_arn = 'arn:aws:sns:'+region+':'+account_id+':'+data['topic_name']
            response = sns.subscribe(
                TopicArn=topic_arn,
                Protocol=data['protocol'],
                Endpoint=data['endpoint'],
            )
            if 'SubscriptionArn' in response and data['protocol']!='email':
                dynamodb = boto3.client('dynamodb')
                dynamodb.update_item(
                    TableName = SUBSCRIPTIONS_TABLE_NAME,
                    Key = {
                        'subscription_arn' : { 'S': response['SubscriptionArn'] }
                    },
                    AttributeUpdates = {
                        'endpoint': {
                            'Value': {
                                'S': data['endpoint']
                            },
                            'Action': 'PUT'
                        },
                        'topic_name': {
                            'Value': {
                                'S': data['topic_name']
                            },
                            'Action': 'PUT'
                        },
                        'protocol': {
                            'Value': {
                                'S': data['protocol']
                            },
                            'Action': 'PUT'
                        }
                    }
                )
        except botocore.exceptions.ClientError as error:
            abort(500, description=error)
        return jsonify(response)
    else:
        abort(500, description="Error subscribing")
        
        
@app.route('/unsubscribe', methods=['POST'])
def unsubscribe():
    data = request.json
    if 'subscription_arn' in data:
        try:
            sns = boto3.client('sns')
            response = sns.unsubscribe(
                SubscriptionArn=data['subscription_arn']
            )
            if response['ResponseMetadata']['HTTPStatusCode']==200:
                dynamodb = boto3.client('dynamodb')
                dynamodb.delete_item(
                    TableName = SUBSCRIPTIONS_TABLE_NAME,
                    Key = {
                        'subscription_arn' : { 'S': data['subscription_arn'] }
                    }
                )
        except botocore.exceptions.ClientError as error:
            abort(500, description=error)
        return jsonify(response)
    else:
        abort(500, description="Error unsubscribing")
        

if __name__ == '__main__':
    app.run(debug=True,host='0.0.0.0')