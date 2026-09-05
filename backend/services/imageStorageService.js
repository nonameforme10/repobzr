/**
 * SalesTrack — ImageKit Cloud Storage Service
 * Provides secure server-side upload, deletion, and authentication parameters
 * for ImageKit media storage and CDN delivery.
 */

const crypto = require('crypto');

const IMAGEKIT_PUBLIC_KEY = process.env.IMAGEKIT_PUBLIC_KEY || process.env.public_key || '';
const IMAGEKIT_PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY || process.env.private_key || '';
const IMAGEKIT_URL_ENDPOINT = (process.env.IMAGEKIT_URL_ENDPOINT || process.env.url_endpoint || '').replace(/\/+$/, '');

const UPLOAD_API_URL = 'https://upload.imagekit.io/api/v1/files/upload';
const API_BASE_URL = 'https://api.imagekit.io/v1/files';

/**
 * Returns Basic Auth header for ImageKit API requests
 */
function getBasicAuthHeader() {
  if (!IMAGEKIT_PRIVATE_KEY) {
    throw new Error('ImageKit private_key is not configured');
  }
  return 'Basic ' + Buffer.from(IMAGEKIT_PRIVATE_KEY + ':').toString('base64');
}

/**
 * Upload an image (base64 Data URL, binary buffer, or remote URL) to ImageKit
 *
 * @param {Object} options
 * @param {string|Buffer} options.file - Base64 string, Data URL, or URL
 * @param {string} [options.fileName] - Target file name
 * @param {string} [options.folder] - Target folder in ImageKit (defaults to '/products')
 * @returns {Promise<Object>} ImageKit response with url, fileId, name, thumbnailUrl
 */
async function uploadImage({ file, fileName, folder = '/products' }) {
  if (!file) {
    throw new Error('Image file data is required');
  }

  const safeFileName = fileName || `product_${Date.now()}_${Math.random().toString(36).substr(2, 6)}.webp`;
  const form = new FormData();
  form.append('file', file);
  form.append('fileName', safeFileName);
  if (folder) form.append('folder', folder);
  form.append('useUniqueFileName', 'true');

  const res = await fetch(UPLOAD_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': getBasicAuthHeader()
    },
    body: form
  });

  if (!res.ok) {
    const errorText = await res.text();
    let errorJson = null;
    try { errorJson = JSON.parse(errorText); } catch (e) {}
    const msg = errorJson?.message || `ImageKit upload failed: HTTP ${res.status}`;
    throw new Error(msg);
  }

  const data = await res.json();
  return {
    url: data.url,
    fileId: data.fileId,
    name: data.name,
    size: data.size,
    width: data.width,
    height: data.height,
    thumbnailUrl: data.thumbnailUrl || data.url
  };
}

/**
 * Delete a file from ImageKit by fileId
 *
 * @param {string} fileId
 * @returns {Promise<boolean>}
 */
async function deleteImage(fileId) {
  if (!fileId) return false;

  const res = await fetch(`${API_BASE_URL}/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: {
      'Authorization': getBasicAuthHeader()
    }
  });

  return res.status === 204 || res.status === 200;
}

/**
 * Generate client-side authentication parameters for ImageKit
 *
 * @param {string} [token] - Optional unique token (generated if omitted)
 * @param {number} [expire] - Optional unix timestamp in seconds
 * @returns {Object} { token, expire, signature, publicKey, urlEndpoint }
 */
function getAuthParams(token, expire) {
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const tokenStr = token || crypto.randomUUID();
  const expireNum = expire || (currentTimestamp + 1800); // valid for 30 minutes

  const signature = crypto
    .createHmac('sha1', IMAGEKIT_PRIVATE_KEY)
    .update(tokenStr + expireNum)
    .digest('hex');

  return {
    token: tokenStr,
    expire: expireNum,
    signature,
    publicKey: IMAGEKIT_PUBLIC_KEY,
    urlEndpoint: IMAGEKIT_URL_ENDPOINT
  };
}

module.exports = {
  uploadImage,
  deleteImage,
  getAuthParams,
  IMAGEKIT_PUBLIC_KEY,
  IMAGEKIT_URL_ENDPOINT
};
