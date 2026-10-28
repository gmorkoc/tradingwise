import Foundation
import Capacitor
import AuthenticationServices
import UIKit

// Passkeys (Face ID / Touch ID) for the native app.
//
// The app's web view runs from capacitor://localhost, so the browser's own
// navigator.credentials can't create or use passkeys for www.coinhintz.io.
// This plugin runs Apple's native passkey sheet instead
// (ASAuthorizationPlatformPublicKeyCredentialProvider). It's tied to the
// domain through the Associated Domains entitlement
// (webcredentials:www.coinhintz.io) plus the apple-app-site-association
// file the website serves.
//
// Input: the WebAuthn options JSON Supabase returns from
// auth.passkey.startRegistration() / startAuthentication().
// Output: the standard RegistrationResponseJSON / AuthenticationResponseJSON
// shape Supabase's verifyRegistration() / verifyAuthentication() expect.
@objc(PasskeyPlugin)
public class PasskeyPlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "PasskeyPlugin"
    public let jsName = "Passkey"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
    ]

    private var pendingCall: CAPPluginCall?
    private var controller: ASAuthorizationController?

    @objc func isSupported(_ call: CAPPluginCall) {
        if #available(iOS 16.0, *) {
            call.resolve(["supported": true])
        } else {
            call.resolve(["supported": false])
        }
    }

    // MARK: Registration

    @objc func create(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else { call.reject("Passkeys need iOS 16 or later"); return }
        guard let options = call.getObject("options"),
              let rp = options["rp"] as? JSObject,
              let rpId = rp["id"] as? String,
              let challengeStr = options["challenge"] as? String,
              let challenge = Self.b64urlDecode(challengeStr),
              let user = options["user"] as? JSObject,
              let userIdStr = user["id"] as? String,
              let userId = Self.b64urlDecode(userIdStr) else {
            call.reject("Invalid passkey registration options")
            return
        }
        let name = (user["name"] as? String) ?? (user["displayName"] as? String) ?? "coinhintz"

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let request = provider.createCredentialRegistrationRequest(challenge: challenge, name: name, userID: userId)
        if let exclude = options["excludeCredentials"] as? [JSObject], #available(iOS 17.4, *) {
            request.excludedCredentials = exclude.compactMap { item in
                guard let idStr = item["id"] as? String, let id = Self.b64urlDecode(idStr) else { return nil }
                return ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: id)
            }
        }
        perform(request, call: call)
    }

    // MARK: Sign-in

    @objc func get(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else { call.reject("Passkeys need iOS 16 or later"); return }
        guard let options = call.getObject("options"),
              let challengeStr = options["challenge"] as? String,
              let challenge = Self.b64urlDecode(challengeStr) else {
            call.reject("Invalid passkey sign-in options")
            return
        }
        // rpId comes from the options; fall back to the app's associated domain.
        let rpId = (options["rpId"] as? String) ?? "www.coinhintz.io"
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        if let allow = options["allowCredentials"] as? [JSObject], !allow.isEmpty {
            request.allowedCredentials = allow.compactMap { item in
                guard let idStr = item["id"] as? String, let id = Self.b64urlDecode(idStr) else { return nil }
                return ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: id)
            }
        }
        perform(request, call: call)
    }

    private func perform(_ request: ASAuthorizationRequest, call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let previous = self.pendingCall {
                previous.reject("Cancelled by a newer passkey request")
            }
            self.pendingCall = call
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.controller = controller
            controller.performRequests()
        }
    }

    // MARK: ASAuthorizationControllerDelegate

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let call = pendingCall else { return }
        pendingCall = nil
        self.controller = nil

        guard #available(iOS 16.0, *) else { call.reject("Passkeys need iOS 16 or later"); return }

        if let reg = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
            let id = Self.b64urlEncode(reg.credentialID)
            var response: JSObject = [
                "clientDataJSON": Self.b64urlEncode(reg.rawClientDataJSON),
                "transports": ["internal", "hybrid"],
            ]
            if let att = reg.rawAttestationObject {
                response["attestationObject"] = Self.b64urlEncode(att)
            }
            call.resolve(["credential": [
                "id": id,
                "rawId": id,
                "type": "public-key",
                "authenticatorAttachment": "platform",
                "clientExtensionResults": [:] as JSObject,
                "response": response,
            ] as JSObject])
            return
        }

        if let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
            let id = Self.b64urlEncode(assertion.credentialID)
            call.resolve(["credential": [
                "id": id,
                "rawId": id,
                "type": "public-key",
                "authenticatorAttachment": "platform",
                "clientExtensionResults": [:] as JSObject,
                "response": [
                    "clientDataJSON": Self.b64urlEncode(assertion.rawClientDataJSON),
                    "authenticatorData": Self.b64urlEncode(assertion.rawAuthenticatorData),
                    "signature": Self.b64urlEncode(assertion.signature),
                    "userHandle": Self.b64urlEncode(assertion.userID),
                ] as JSObject,
            ] as JSObject])
            return
        }

        call.reject("Unexpected passkey response")
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let call = pendingCall else { return }
        pendingCall = nil
        self.controller = nil
        if let authError = error as? ASAuthorizationError, authError.code == .canceled {
            call.reject("cancelled", "CANCELLED")
        } else {
            call.reject(error.localizedDescription)
        }
    }

    // MARK: ASAuthorizationControllerPresentationContextProviding

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    // MARK: base64url helpers

    static func b64urlDecode(_ s: String) -> Data? {
        var str = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while str.count % 4 != 0 { str += "=" }
        return Data(base64Encoded: str)
    }

    static func b64urlEncode(_ d: Data) -> String {
        return d.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
