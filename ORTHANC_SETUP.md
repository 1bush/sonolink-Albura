# Orthanc setup for SonoLink

1. Install Orthanc and the official DICOMweb plugin on a clinic server.
2. Configure SonoScape P50 to send DICOM Storage to Orthanc (AE title, server IP, port).
3. Enable HTTPS and authentication on Orthanc or put it behind an authenticated reverse proxy.
4. In SonoLink Settings, enter the Orthanc base URL, for example:

```text
https://orthanc.example.invalid
```

5. Enter the API token only on the device. It is stored with Expo SecureStore.
6. Press “Ruaj dhe testo Orthanc”.

The mobile app is a DICOMweb/REST client, not a DICOM Storage SCP. Orthanc is
the server that receives DICOM from the ultrasound device. The direct QR/TCP
transport remains available, but its file framing is not confirmed by public
SonoScape documentation and must not be trusted with real patient studies until
validated on a test network with synthetic data.