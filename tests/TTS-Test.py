import requests
import base64
import json
import os

# URL of our FastAPI service
# (Change to your Cloudflare URL if testing the public link)
# url = "http://localhost:8000/v1/audio/speech"
url = "https://barry-again-articles-spending.trycloudflare.com/v1/audio/speech"  # Example Cloudflare URL

# The text we want to synthesize
payload = {
    "text": "भारत दुनिया क सबसे विविधता वाला देस हवे, जहाँ हर कुछ दूर पर भाषा अउरी संस्कृति बदल जाले। ई मुख्य रूप से बिहार, उत्तर प्रदेश, अउरी झारखंड में बोलल जाए वाली भोजपुरी भाषा क केंद्र हवे, जेवन लगभग 50 मिलियन से जादे लोग बोलें। भोजपुरी संस्कृति भारत क सॉफ्ट पावर क एक प्रमुख हिस्सा हवे, जेवन अपना लोक गीत, खान-पान अउरी छठ नियर त्योंहार से पहिचानल जाला।",
    "cfg_value": 2.0,
    "inference_timesteps": 10
}

# -------------------------------------------------------------
# VOICE CLONING (Optional)
# If you want to clone a voice, uncomment the code below:
# -------------------------------------------------------------
audio_file_path = "RecordingPraveenBhoj.m4a"

if os.path.exists(audio_file_path):
    print(f"Found reference audio: {audio_file_path}. Adding it to payload for Voice Cloning!")
    with open(audio_file_path, "rb") as audio_file:
        base64_audio = base64.b64encode(audio_file.read()).decode("utf-8")
        payload["reference_audio_base64"] = base64_audio
else:
    print("No reference audio provided. Generating a brand new voice instead.")
    payload["control_instruction"] = "A cheerful young woman, energetic and clear."
# -------------------------------------------------------------

print(f"Sending request to {url}...")

response = requests.post(url, json=payload)

if response.status_code == 200:
    output_filename = "cloned_output.wav"
    with open(output_filename, "wb") as f:
        f.write(response.content)
    print(f"Success! Audio saved to {output_filename}")
else:
    print(f"Error: {response.status_code}")
    print(response.text)
