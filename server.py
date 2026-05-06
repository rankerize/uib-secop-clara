import os
import json
import logging
import tempfile
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from io import BytesIO
import PyPDF2
from fastapi import FastAPI, UploadFile, Form, File
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from dotenv import load_dotenv
from playwright.async_api import async_playwright
import firebase_admin
from firebase_admin import credentials, firestore

load_dotenv()

# Initialize Firebase
firebase_creds_json = os.getenv("FIREBASE_SERVICE_ACCOUNT")
if firebase_creds_json:
    try:
        cred_dict = json.loads(firebase_creds_json)
        cred = credentials.Certificate(cred_dict)
        firebase_admin.initialize_app(cred)
        db = firestore.client()
        logging.info("Firebase Admin initialized successfully")
    except Exception as e:
        logging.error(f"Failed to initialize Firebase: {e}")
        db = None
else:
    logging.warning("FIREBASE_SERVICE_ACCOUNT not found in environment variables")
    db = None

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

SYSTEM_PROMPT = """Eres un experto suscriptor y analista de REASEGUROS internacionales.
Tu objetivo es analizar pliegos de condiciones y anexos técnicos para extraer la estructura de aseguramiento exigida.
Se te entregará un texto base y el contenido extraído de documentos PDF de SECOP.
Responde SIEMPRE en formato JSON con la siguiente estructura exacta:
{
  "resumen_empresa": "Breve perfil de la entidad y su operación.",
  "investigacion_inicial": "Análisis del alcance del proyecto y por qué es una oportunidad para UIB.",
  "condiciones_tecnicas": {
     "objeto_seguro": "Descripción técnica de lo que se debe asegurar.",
     "amparos": ["Lista de amparos obligatorios detectados (ej: Casco, RC, Guerra, etc)"],
     "deducibles": "Deducibles exigidos según el pliego.",
     "vigencia": "Periodo de cobertura solicitado."
  },
  "valores_seguros": [
     {
        "tipo_seguro": "Nombre de la póliza específica.",
        "valor": "Límite de indemnización o suma asegurada exigida.",
        "detalles": "Cualquier condición especial o garantía detectada."
     }
  ],
  "analisis_riesgos": [
     "Evaluación de riesgo para el reasegurador (zonas, tipos de aeronaves, historial, etc)."
  ]
}
Retorna exclusivamente JSON. Si no encuentras datos específicos, usa "No especificado en el fragmento analizado".
"""

def extract_pdf_text(pdf_bytes: bytes) -> str:
    text = ""
    try:
        reader = PyPDF2.PdfReader(BytesIO(pdf_bytes))
        # Para evitar problemas de tokens, limitaremos a las primeras 25 páginas
        for i, page in enumerate(reader.pages):
            if i >= 25: 
                break
            t = page.extract_text()
            if t:
                text += t + "\n"
    except Exception as e:
        logging.error(f"Error reading PDF: {e}")
    
    return text[:60000] # Aproximadamente 15,000 words limite

async def fetch_secop_data(url: str) -> str:
    extracted_text = ""
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(accept_downloads=True)
            page = await context.new_page()
            
            # Navigate and wait for content
            await page.goto(url, wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_timeout(5000) # wait for dynamic components
            
            # Attempt to click anything that looks like a document download
            js_script = """
            () => {
                let links = Array.from(document.querySelectorAll('a, button, span'));
                let target = links.find(el => {
                    let text = (el.innerText || '').toLowerCase();
                    let title = (el.getAttribute('title') || '').toLowerCase();
                    // Priorizamos Anexos Técnicos y Seguros
                    return text.includes('anexo técnico') || text.includes('seguro') || text.includes('técnico') || text.includes('pliego') || title.includes('descargar');
                });
                if(target) { target.click(); return true; }
                return false;
            }
            """
            
            try:
                async with page.expect_download(timeout=10000) as download_info:
                    clicked = await page.evaluate(js_script)
                    if clicked:
                        download = await download_info.value
                        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
                            await download.save_as(tmp.name)
                            tmp_path = tmp.name
                            
                        # Extract PDF
                        with open(tmp_path, "rb") as f:
                            reader = PyPDF2.PdfReader(f)
                            # Ampliamos a 50 páginas para capturar anexos al final
                            for i, page_obj in enumerate(reader.pages):
                                if i >= 50: break
                                t = page_obj.extract_text()
                                if t: extracted_text += t + "\n"
                        os.remove(tmp_path)
            except Exception as e:
                logging.warning(f"No se pudo descargar el PDF, extrayendo DOM. Error: {e}")
                
            # If PDF extraction failed or yielded nothing, extract the page text as fallback
            if len(extracted_text.strip()) < 100:
                extracted_text = await page.evaluate("document.body.innerText")
                
            await browser.close()
    except Exception as e:
        logging.error(f"Error fetching SECOP url: {e}")
        extracted_text = f"Error obteniendo contenido: {str(e)}"
        
    return extracted_text[:60000]

@app.post("/analyze")
async def analyze_tender(
    emailText: str = Form(""),
    secopUrl: str = Form("")
):
    try:
        pdf_text = ""
        if secopUrl and "secop.gov.co" in secopUrl:
            pdf_text = await fetch_secop_data(secopUrl)
        
        user_content = f"CORREO DE ENTRADA O RESUMEN:\n{emailText}\n\nTEXTO EXTRAIDO DE SECOP (PLIEGO O WEB):\n{pdf_text}"

        response = client.chat.completions.create(
            model="gpt-4o-mini",
            temperature=0.2,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content}
            ],
            response_format={"type": "json_object"}
        )
        
        result_str = response.choices[0].message.content
        result_json = json.loads(result_str)
        return result_json

    except Exception as e:
        return {"error": str(e)}

import datetime
import requests

SECOP_II_PROCESOS_API = "https://www.datos.gov.co/resource/p6dx-8zbt.json"

def get_new_opportunities():
    """Busca oportunidades reales en SECOP II de alto valor."""
    try:
        # Buscamos procesos de los últimos 4 días (para cubrir el gap entre Lunes y Jueves)
        today = datetime.datetime.now()
        date_limit = (today - datetime.timedelta(days=4)).strftime("%Y-%m-%dT%H:%M:%S")
        
        # Query SODA: Cuantía > 1,000M y fecha reciente
        query = (
            f"?$where=cuantia_del_proceso > 1000000000 "
            f"AND fecha_de_publicacion_del_proceso > '{date_limit}' "
            f"&$limit=20"
        )
        
        response = requests.get(SECOP_II_PROCESOS_API + query)
        if response.status_code == 200:
            data = response.json()
            # Filtrar por palabras clave de interés
            keywords = ["seguro", "póliza", "aviación", "aéreo", "casco", "vida", "transporte"]
            filtered = []
            for item in data:
                desc = (item.get("nombre_del_procedimiento", "") + " " + item.get("descripcion_del_procedimiento", "")).lower()
                if any(k in desc for k in keywords):
                    filtered.append({
                        "entidad": item.get("nombre_entidad", "Entidad"),
                        "objeto": item.get("nombre_del_procedimiento", "Sin objeto"),
                        "valor": f"${int(float(item.get('cuantia_del_proceso', 0))):,}",
                        "link": f"https://community.secop.gov.co/Public/Tendering/OpportunityDetail/Index?noticeUID={item.get('uid', '')}"
                    })
            return filtered
        return []
    except Exception as e:
        logging.error(f"Error fetching SECOP data in Python: {e}")
        return []

@app.post("/alerts/trigger")
async def trigger_alerts():
    if not db:
        return {"error": "Firebase not initialized"}
    
    # 0. Validar día de la semana (Lunes=0, Jueves=3)
    # Si quieres probarlo hoy, podrías comentar esta validación temporalmente
    day_of_week = datetime.datetime.now().weekday()
    if day_of_week not in [0, 3]: 
        return {"message": "Hoy no es día de alertas (Lunes o Jueves). Tarea abortada."}

    try:
        # 1. Get subscribers (de la colección 'users' que creamos en app.js)
        users_ref = db.collection('users').where('newsletter', '==', True)
        subscribers = [doc.to_dict() for doc in users_ref.stream()]
        
        if not subscribers:
            return {"message": "No active subscribers found"}

        # 2. Fetch REAL opportunities
        opportunities = get_new_opportunities()
        
        if not opportunities:
            return {"message": "No hay nuevas oportunidades de alto valor hoy."}

        # 3. Send emails
        sent_count = 0
        smtp_user = os.getenv("SMTP_USER")
        smtp_password = os.getenv("SMTP_PASSWORD")

        if not smtp_user or not smtp_password:
            return {"error": "SMTP credentials missing", "subscribers_found": len(subscribers)}

        for sub in subscribers:
            msg = MIMEMultipart()
            msg['From'] = f"UIB Alert Hub <{smtp_user}>"
            msg['To'] = sub['email']
            msg['Subject'] = f"🚀 {len(opportunities)} Nuevas Licitaciones SECOP - {sub['name']}"

            html = f"""
            <html>
                <body style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
                    <div style="background-color: #002238; padding: 30px; text-align: center;">
                        <h1 style="color: #009CDE; margin: 0; font-size: 24px;">UIB REASEGUROS HUB</h1>
                        <p style="color: white; margin-top: 10px;">Resumen de Oportunidades de Alto Valor</p>
                    </div>
                    <div style="padding: 30px; background-color: #f9f9f9;">
                        <h2 style="color: #002238;">Hola {sub['name']},</h2>
                        <p>Estas son las licitaciones de <b>+$1.000M</b> detectadas en las últimas 96 horas:</p>
                        <br>
                        {"".join([f'''
                        <div style="background: white; padding: 20px; border-radius: 10px; border-left: 5px solid #00A651; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.05);">
                            <p style="margin: 0; font-size: 0.9rem; color: #777;">{o["entidad"]}</p>
                            <h3 style="margin: 10px 0; color: #002238;">{o["objeto"]}</h3>
                            <p style="margin: 0; font-weight: bold; color: #00A651; font-size: 1.2rem;">{o["valor"]}</p>
                            <br>
                            <a href="{o["link"]}" style="background-color: #009CDE; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Ver en SECOP</a>
                        </div>
                        ''' for o in opportunities])}
                        <br>
                        <p style="font-size: 0.8rem; color: #777; text-align: center;">Este es un servicio automatizado de UIB Colombia. Alertas programadas para Lunes y Jueves.</p>
                    </div>
                </body>
            </html>
            """
            msg.attach(MIMEText(html, 'html'))

            with smtplib.SMTP("smtp.gmail.com", 587) as server:
                server.starttls()
                server.login(smtp_user, smtp_password)
                server.send_message(msg)
                sent_count += 1

        return {"status": "success", "emails_sent": sent_count, "opportunities_found": len(opportunities)}

    except Exception as e:
        logging.error(f"Error in trigger_alerts: {e}")
        return {"error": str(e)}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
