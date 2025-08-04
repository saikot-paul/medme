// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs

interface BookingSearch {
  cal_event_id?: string;
  patient_name?: string;
  patient_contact?: string;
  start_time?: string;   
  end_time?:   string;   
}

import { crypto } from "https://deno.land/std@0.203.0/crypto/mod.ts";

const CAL_SECRET = Deno.env.get("CAL_WEBHOOK_SECRET")
const SERVICE_KEY = Deno.env.get("SERVICE_ROLE_KEY")
const URL = Deno.env.get("URL")
const postgrest = `http://host.docker.internal:54321/rest/v1/bookings`

function verifyAuthHeader(req: Request): { valid: boolean; status?: number; error?: string } {
  console.log('Here')
  const token = req.headers.get("authorization");
  console.log(token)
  const bearerString = `Bearer ${CAL_SECRET}`;

  if (!token) {
    return { valid: false };
  }

  if (token === CAL_SECRET || token === bearerString) {
    console.error("Invalid token")
    return { valid: true };
  }

  return { valid: false }
}


async function verifyCalSignature(rawBody: ArrayBuffer, req: Request): Promise<{ valid: boolean, status?: number, error?: string }> {
  const signature = req.headers.get("x-cal-signature-256");

  if (!signature) {
    return {
      valid: false,
    };
  }


  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(CAL_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBytes = await crypto.subtle.sign("HMAC", key, rawBody);
  const signatureHex = Array.from(new Uint8Array(signatureBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (signatureHex !== signature) {
    console.error("Invalid signature")
    return {
      valid: false,
    };
  }

  return { valid: true };
}

function createRequest(method, body) { 
  const params = {
    method: method, 
    headers: { 
      'Content-Type': 'application/json', 
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    }
  }
  
  if (body) { 
    params["body"] = JSON.stringify(body)
  }

  return params
}

function createQuery(params: BookingSearch) { 
  const query: string[] = []; 

  if (params.cal_event_id)
    query.push(`cal_event_id.eq.${encodeURIComponent(params.cal_event_id)}r`);

  if (params.patient_name)
    query.push(`patient_name.ilike.*${encodeURIComponent(params.patient_name)}*`);

  if (params.patient_contact)
    query.push(`patient_contact.eq.${encodeURIComponent(params.patient_contact)}`);

  if (params.start_time)
    query.push(`start_time.eq.${encodeURIComponent(params.start_time)}`);

  if (params.end_time)
    query.push(`end_time.eq.${encodeURIComponent(params.end_time)}`);

  if (query.length === 0)
    throw new Error("Provide at least one search criterion");

  const queryString =  `or(${query.join(",")})`

  return queryString
}

async function createBooking(payload) { 
  const row = {
    cal_event_id: payload.uid,
    appointment_type: payload.type,
    patient_name: payload.attendees?.[0]?.name ?? null,
    patient_contact: payload.attendees?.[0]?.email ?? null,
    appointment_time: payload.startTime ? new Date(payload.startTime).toISOString().slice(0,10) : null,
    status: payload.status,
    start_time: payload.startTime,
    end_time: payload.endTime,
    modified_at: new Date().toISOString()
  };

  const params = createRequest("POST", row)
  try { 
    const res = await fetch(postgrest, params)
    return res
  }catch(error) { 
    console.error(error)
  }
}

async function getBooking(payload) { 
  const cal_event_id = payload.uid 
  const patient_name = payload.patient_name
  const patient_contact = payload.patient_contact
  const start_time = payload.start_time
  const end_time = payload.end_time

  const queryString = createBooking({
    cal_event_id, 
    patient_name, 
    patient_contact, 
    start_time, 
    end_time
  })

  const req = createRequest("GET", null)
  const res = await fetch(`${postgrest}?${queryString}`)
  
  return res

}

async function updateBooking(url, request) { 
  const res = await fetch(url, request)

  return res
} 

async function rescheduleBooking(payload) { 
  const { uid, rescheduleUid } = payload 
  const queryStr =  `cal_event_id=eq.${uid}`
  const url = `${postgrest}?${queryStr}`
  const body = { 
    "status": "RESCHEDULED", 
    "cal_event_id": rescheduleUid, 
    "modified_at": new Date().toLocaleString("en-CA", {timeZone: "America/Toronto"})
  }
  
  try { 
    // UPDATE OLD
    const params = createRequest("PATCH", body)
    const updatePrev = await updateBooking(url, params)
  
    // CREATE NEW BOOKING
    const res = await createBooking(payload)

  }catch(error) { 
    console.error('Error rescheduling booking: ', error)
  }
}

async function cancelBooking(payload) { 
  const { uid } = payload 
  const queryStr =  `cal_event_id=eq.${uid}`
  const url = `${postgrest}?${queryStr}`
  const body = { 
    "status": "CANCELLED", 
    "cal_event_id": uid, 
    "modified_at": new Date().toLocaleString("en-CA", {timeZone: "America/Toronto"})
  }

  try { 
    // UPDATE OLD
    const params = createRequest("PATCH", body)
    const updatePrev = await updateBooking(url, params)
  
    return updatePrev 
  }catch(error) { 
    console.error('Error cancelling booking', error)
  }
}

Deno.serve(async (req) => {

  console.log({
    method: req.method,
    url: req.url,
    headers: Object.fromEntries(req.headers),
  });

    
  try {
    const rawBody = await req.arrayBuffer()
    const verifySignature = await verifyCalSignature(rawBody, req);
    const validSignature = verifySignature.valid
    const verifyToken = verifyAuthHeader(req)
    const validToken = verifyToken.valid

    if (!validToken && !validSignature) {
      return new Response(
        JSON.stringify(
        { 
          ok: false, 
          error: "Unauthorized Access"
        }),
        { status: 401, 
          headers: { "Content-Type": "application/json" } 
        }
      );
    }
    
    const body = JSON.parse(new TextDecoder().decode(rawBody))
    const { payload } = body 
    console.log('Payload: ', payload)

    const event = body.triggerEvent

    let res; 

    switch (event) { 
      case "BOOKING_CREATED": 
        res = await createBooking(payload) 
        if (!res.ok) { 
          const error = await res.text() 
          console.error('Error inserting into table: ', error)
          return new Response(
            JSON.stringify({
              ok: false
            }), { 
              headers: { 
                "Content-Type": "application/json"
              }
          })
        }

        console.log("Successful DB write")
        
        return new Response(
          JSON.stringify({
            ok: true
          }), { 
            status: 200, 
            headers: { 
              "Content-Type": "application/json"
            }
        })
      
      case "BOOKING_RESCHEDULED": 
        res = await rescheduleBooking(payload)
        if (!res.ok) { 
          const error = await res.text() 
          console.error('Error inserting into table: ', error)
          return new Response(
            JSON.stringify({
              ok: false
            }), { 
              headers: { 
                "Content-Type": "application/json"
              }
          })
        }

        console.log("Successful DB write")
        
        return new Response(
          JSON.stringify({
            ok: true
          }), { 
            status: 200, 
            headers: { 
              "Content-Type": "application/json"
            }
        })
      
      case "BOOKING_CANCELLED": 
        res = await cancelBooking(payload)
        if (!res.ok) { 
            const error = await res.text() 
            console.error('Error inserting into table: ', error)
            return new Response(
              JSON.stringify({
                ok: false
              }), { 
                headers: { 
                  "Content-Type": "application/json"
                }
            })
          }

          console.log("Successful DB write")
          
          return new Response(
            JSON.stringify({
              ok: true
            }), { 
              status: 200, 
              headers: { 
                "Content-Type": "application/json"
              }
          })
        
        case "GET_BOOKINGS": 
          res = await getBooking(payload)
          if (!res.ok) { 
            return new Response(
              JSON.stringify({
                ok: false
              }), { 
                status: 500, 
                headers: { 
                  "Content-Type": "application/json"
                }
            })
          }

          console.log(JSON.stringify(res))
          const data = await res?.json()
          const body = data.map( item => {
            return { 
              "uid": item.cal_event_id, 
              "appointment_type": item.appointment_type,
              "start_time": item.start_time,
              "end_time": item.end_time
            }
          })

          return new Response(
              JSON.stringify({
                ok: false,
                body: JSON.stringify(body)
              }), { 
                status: 500, 
                headers: { 
                  "Content-Type": "application/json"
                }
            })

    }


    return new Response(
      JSON.stringify({
        ok: true
      }), { 
        status: 200, 
        headers: { 
          "Content-Type": "application/json"
        }
    })


    
  } catch (err) {
    console.error("Error verifying signature:", err);
    return new Response(JSON.stringify({ ok: false, error: "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

