import json

print('Loading function')

def handler(event, context):
    #print("Received event: " + json.dumps(event, indent=2))
    print(event)
    return True  # Echo back the first key value
    #raise Exception('Something went wrong')
