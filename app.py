from fastapi import FastAPI, UploadFile, File
import shutil
import os
import subprocess
import cv2
import pytesseract
from PIL import Image

app = FastAPI()

UPLOAD_DIR = "data"
os.makedirs(UPLOAD_DIR, exist_ok=True)

@app.post("/process-video")
async def process_video(file: UploadFile = File(...)):
    input_path = os.path.join(UPLOAD_DIR, "input.mp4")
    output_path = os.path.join(UPLOAD_DIR, "output.mp4")
    frames_dir = os.path.join(UPLOAD_DIR, "frames")

    # Save uploaded video
    with open(input_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    # Step 1: Extract frames
    subprocess.run([
        "ffmpeg", "-i", input_path, f"{frames_dir}/frame_%04d.png"
    ])

    os.makedirs(frames_dir, exist_ok=True)

    # Step 2: OCR + remove text
    for frame_name in os.listdir(frames_dir):
        frame_path = os.path.join(frames_dir, frame_name)

        img = cv2.imread(frame_path)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        data = pytesseract.image_to_data(gray, output_type=pytesseract.Output.DICT)

        for i in range(len(data['text'])):
            if int(data['conf'][i]) > 60:
                x, y, w, h = data['left'][i], data['top'][i], data['width'][i], data['height'][i]
                
                # Remove text (simple white box)
                cv2.rectangle(img, (x, y), (x+w, y+h), (255,255,255), -1)

                # Add styled text
                cv2.putText(
                    img,
                    data['text'][i],
                    (x, y),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    1,
                    (0,0,255),
                    2
                )

        cv2.imwrite(frame_path, img)

    # Step 3: Rebuild video
    subprocess.run([
        "ffmpeg",
        "-framerate", "30",
        "-i", f"{frames_dir}/frame_%04d.png",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        output_path
    ])

    return {"output": output_path}