export const decodeJwt = (token) => {
  try {
    const payload = token.split(".")[1];
    const decoded = JSON.parse(atob(payload));
    return {
      login: decoded.login,
      userId: decoded.userId,
      loginId: decoded.loginId,
      longitude: decoded.longitude,
      latitude: decoded.latitude,
      nick_name: decoded.login
    };
  } catch {
    return null;
  }
};