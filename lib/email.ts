import nodemailer from "nodemailer";

type CandidateInviteEmailInput = {
  toEmail: string;
  roundTitle: string;
  roundDescription: string | null;
  ownerEmail: string | null;
  acceptUrl: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

function getTransporter() {
  const host = requiredEnv("SMTP_HOST");
  const port = Number(requiredEnv("SMTP_PORT"));
  const user = requiredEnv("SMTP_USER");
  const pass = requiredEnv("SMTP_PASS");

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

function buildCandidateInviteHtml(input: CandidateInviteEmailInput) {
  const supportEmail = input.ownerEmail ?? "support@interview-platform.local";
  const description = input.roundDescription?.trim() || "No description provided.";

  return `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Interview Invitation</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,sans-serif;color:#18181b;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f4f5;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:640px;background:#ffffff;border:1px solid #e4e4e7;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:28px 28px 16px;border-bottom:1px solid #f4f4f5;">
                <p style="margin:0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#71717a;">Interview Invitation</p>
                <h1 style="margin:8px 0 0;font-size:24px;line-height:1.2;">${input.roundTitle}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 28px;">
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
                  <tr>
                    <td style="font-size:14px;color:#52525b;padding:0 0 14px;line-height:1.6;">
                      You have been invited to join this interview round. Please review the details and accept the invitation.
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e4e4e7;border-radius:10px;">
                        <tr>
                          <td style="padding:14px;border-bottom:1px solid #f4f4f5;font-size:13px;color:#71717a;">Round Description</td>
                        </tr>
                        <tr>
                          <td style="padding:14px;font-size:14px;line-height:1.5;">${description}</td>
                        </tr>
                        <tr>
                          <td style="padding:14px;border-top:1px solid #f4f4f5;font-size:13px;color:#71717a;">
                            Support Contact: <span style="color:#18181b;">${supportEmail}</span>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td align="center" style="padding:24px 0 8px;">
                      <a href="${input.acceptUrl}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px;font-size:14px;">
                        Accept Invitation
                      </a>
                    </td>
                  </tr>
                  <tr>
                    <td style="font-size:12px;color:#71717a;text-align:center;line-height:1.5;">
                      If the button does not work, copy and paste this link:
                      <br />
                      <a href="${input.acceptUrl}" style="color:#18181b;word-break:break-all;">${input.acceptUrl}</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
}

export async function sendCandidateInviteEmail(input: CandidateInviteEmailInput) {
  const fromEmail = process.env.SMTP_FROM_EMAIL?.trim() || requiredEnv("SMTP_USER");
  const transporter = getTransporter();

  await transporter.sendMail({
    from: fromEmail,
    to: input.toEmail,
    subject: `Interview invite: ${input.roundTitle}`,
    html: buildCandidateInviteHtml(input),
  });
}
