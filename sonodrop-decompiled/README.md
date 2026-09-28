# SonoDrop decompiled reference (com.sonoscape.usalbum)

Smali disassembly of the SonoDrop/USAlbum app, extracted from
`classes.dex` of the APK on the Desktop. This is the evidence behind
`src/services/framing.ts` and `src/services/sonodropCrypto.ts`.

## Why this exists

The file-transfer framing was the largest unverified part of SonoLink. It is
now read from the original app rather than guessed, and this folder is the
proof. It was deleted after the first pass; keeping it means the next person
does not have to re-download apktool and re-disassemble a 4.4 MB dex.

## What is here

Only `com/sonoscape/usalbum/` -- the app's own code. The AndroidX,
OkHttp and Kotlin library smali is excluded: it is thousands of files of
no interest to this project, and the machine-readable index below points at
the handful of classes that actually carry the protocol.

## The files that matter

| File | What it proves |
|---|---|
| `nettransfer/DataTransferThread.smali` | The 256-byte header read, the msgType/length slicing, the TLV offset of 12, and the msgType constants 1000/2000/5000/5001 |
| `util/TLVHelper.smali` | TLV = [type:4][len:4][value:len], all decimal ASCII |
| `activity/QRInfoParser.smali` | QR types 0x2328..0x232e = 9000..9006 and TLV_NUM = 6 |
| `activity/RemoteFragment.smali` | The client side of the socket connection |
| `activity/HomeFragment.smali` | `DecryptValue(mPsswd, mIP)` and `DecryptValue(mPsswd, mPort)` -- the WiFi password is the decryption key |
| `util/Constant.smali` | Paths (`Sonodrop/gallery`, `Sonodrop/database`) and the file-type names |
| `activity/FileDecyptDialog.smali` | The UI for removing decryption from a stored file |

## The native half

The actual parsing is JNI, in `lib/arm64-v8a/libklnetio.so` (0.8 MB),
which is NOT copied here. Its exported symbols are what pinned the design:

```
KLNetIO::GetFileHead / DecryptFile / DecryptValue   (JNI entry points)
KFileHeadParser::ParseHead / GetFileHead            KFileHead
KTLVFieldHelper::IntTo4ByteString / StringToInt      KTLV
KFileEncrypt::Encryption                            KClientInfoWrapper
```

Two things were read out of the binary itself and are recorded in the source
comments: an 8-character literal `19040435` in `.rodata` next to
the `".enc"` string, and the fact that `KFileEncrypt::Encryption` is
NOT a plain XOR (the library holds 36 EOR instructions, only one of them
inside KFileEncrypt, none inside DecryptFile).

The original `sonodrop-source/` folder in the repo root holds the extracted
APK, and `C:/Users/roven/Desktop/sono_drop_6.0.1.119/` is a byte-identical
copy of it. All three are the same 4.41 MB dex.

## Regenerating

```bash
# apktool needs a zip, not an extracted directory
zip -r apk.zip sono_drop_6.0.1.119/*
java -jar apktool.jar d apk.zip -o out -f
# then keep only out/smali/com/sonoscape/usalbum/
```

apktool 2.9.3: https://github.com/iBotPeaches/Apktool/releases

## Legal

This is another vendor's application, kept locally for interoperability
analysis only. It is not part of the SonoLink application, is not compiled
into it, and must not be redistributed.
