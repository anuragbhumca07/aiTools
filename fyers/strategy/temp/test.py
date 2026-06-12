# Import the required module from the fyers_apiv3 package
from fyers_apiv3 import fyersModel

# Replace these values with your actual API credentials
client_id = "KZZ4Y6S6F2-200"
secret_key = "HaQvYYVPkQ0OAlYI"
redirect_uri = "https://trade.fyers.in/api-login/redirect-uri/index.html"
response_type = "code"  
state = "sample_state"

# Create a session model with the provided credentials
session = fyersModel.SessionModel(
    client_id=client_id,
    secret_key=secret_key,
    redirect_uri=redirect_uri,
    response_type=response_type
)

# Generate the auth code using the session model
response = session.generate_authcode()

# Print the auth code received in the response
print(response)


----------------------------------------------------------------------------------
SAMPLE SUCCESS RESPONSE : 
----------------------------------------------------------------------------------

https://api-t1.fyers.in/api/v3/generate-authcode?
client_id=SPXXXXE7-100&
redirect_uri=https%3A%2F%2Fdev.fyers.in%2Fredirection%2Findex.html
&response_type=code&state=sample_state&nonce=sample_nonce

