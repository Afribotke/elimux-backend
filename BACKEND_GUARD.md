# ElimuX Backend Guardrails

## ⚠️ CRITICAL: Only ONE Backend Service Allowed

**Project:** elimux-backend (Railway)
**Live Domain:** api.elimux.ke
**Database:** Supabase (ohlgjvenwekpbpkykutz)

### DO NOT
- ❌ Create a second backend service in any Railway project
- ❌ Deploy the backend to Vercel (frontend only)
- ❌ Create a new Railway project for the backend
- ❌ Run `railway up` from a different project directory
- ❌ Copy the backend repo to a new folder and deploy

### DO
- ✅ Only deploy from: `C:\Users\ELON\Projects-2026\IDEA STORE\elimux-backend\`
- ✅ Only use the `elimux-backend` Railway project
- ✅ Verify `api.elimux.ke` is responding before considering any deployment "done"
- ✅ Run `.\scripts\check-before-deploy.ps1` before every deploy
- ✅ Check `railway status` shows the correct project before deploying

### If You See Two Backend Services
1. STOP — do not deploy
2. Check which one has the domain `api.elimux.ke`
3. Delete the one WITHOUT the domain
4. Verify the live one still works

### Verification Command

```powershell
curl -s -o /dev/null -w "%{http_code}" https://api.elimux.ke/health
# Should return 200
```
